import type { AgentJobPayload } from "@ticket-to-pr/queue";
import type { InternalPhase, UserOutcome } from "@ticket-to-pr/core";
import type { MetricsSummary } from "@ticket-to-pr/db";
import type { FastifyInstance } from "fastify";
import { assertAdminToken } from "./auth.js";

export interface AdminRepositories {
  listJobs(): Promise<Array<Record<string, unknown>>>;
  getJob(jobId: string): Promise<Record<string, unknown> | null>;
  getJobEvents(jobId: string): Promise<Array<Record<string, unknown>>>;
  getJobLogs(jobId: string): Promise<Array<Record<string, unknown>>>;
  getJobArtifacts(jobId: string): Promise<Array<Record<string, unknown>>>;
  requestCancel(jobId: string, actor: string): Promise<CancelRequestView>;
  getRetryPreflight(jobId: string): Promise<RetryPreflightView | null>;
  createRetryAttempt(
    jobId: string,
    actor: string,
    guidance?: RetryGuidanceView,
  ): Promise<{ runId: string; attempt: number }>;
  /**
   * Resume a parked NeedsInput job by injecting the operator's answer (reuses the
   * retry-with-guidance plumbing: the answer is persisted as the new run's
   * guidance). Throws an HTTP-coded error — 404 (job not found) / 409 (job is not
   * awaiting input, or the answer is empty) — which the route maps to a status.
   */
  answerNeedsInput(jobId: string, answer: string, actor: string): Promise<{ runId: string; attempt: number }>;
  getMetrics(periodDays?: number): Promise<MetricsSummary>;
  transitionJob(jobId: string, phase: InternalPhase, outcome: UserOutcome, reason?: string): Promise<void>;
  appendEvent(input: {
    jobId: string;
    runId?: string;
    attempt?: number;
    phase: string;
    eventType: string;
    source: string;
    message: string;
    metadata?: unknown;
  }): Promise<void>;
}

export interface RetryPreflightView {
  retryable: boolean;
  /** Present phase (when known) so the route can decide if guidance unlocks a retry. */
  phase?: string;
  /** Present outcome (when known) so the route can permit FailedActionable + guidance. */
  outcome?: string;
}

/** Operator guidance threaded into a retry (X4). */
export interface RetryGuidanceView {
  guidance?: string | null;
}

/** Max length of an operator guidance note; keeps the steering blurb bounded. */
const MAX_GUIDANCE_LENGTH = 4000;

/** Max length of an operator answer to a NeedsInput question (same bound as guidance). */
const MAX_ANSWER_LENGTH = 4000;

export type CancelRequestView =
  | { status: "requested" }
  | { status: "not_found" }
  | { status: "not_cancelable"; phase?: string };

export interface AdminQueue {
  /**
   * `opts.jobId` is the BullMQ dedup key (X6): two `add` calls with the same
   * jobId collapse to one queued job, so a double-submitted retry cannot enqueue
   * the same attempt twice. Optional to stay back-compatible with callers/tests
   * that pass no opts.
   */
  add(name: string, data: AgentJobPayload, opts?: { jobId?: string }): Promise<unknown>;
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  repos: AdminRepositories,
  queue: AdminQueue,
  adminToken: string,
): Promise<void> {
  app.addHook("preHandler", async (request) => {
    // Both the job console and the owner metrics dashboard are admin-only. Match
    // on the path prefix (ignoring any query string) so `/api/metrics?days=7` is
    // protected exactly like `/api/jobs`.
    const path = request.url.split("?", 1)[0] ?? "";
    if (path.startsWith("/api/jobs") || path.startsWith("/api/metrics")) {
      assertAdminToken(request, adminToken);
    }
  });

  app.get<{ Querystring: { days?: string } }>("/api/metrics", async (request, reply) => {
    const periodDays = parsePeriodDays(request.query.days);
    if (periodDays === "invalid") {
      return reply.code(400).send({ error: "Query parameter 'days' must be a positive integer" });
    }
    return repos.getMetrics(periodDays);
  });

  app.get("/api/jobs", async () => repos.listJobs());
  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (request, reply) => {
    const job = await repos.getJob(request.params.id);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    return job;
  });
  app.get<{ Params: { id: string } }>("/api/jobs/:id/events", async (request) => repos.getJobEvents(request.params.id));
  app.get<{ Params: { id: string } }>("/api/jobs/:id/logs", async (request) => repos.getJobLogs(request.params.id));
  app.get<{ Params: { id: string } }>("/api/jobs/:id/artifacts", async (request) =>
    repos.getJobArtifacts(request.params.id),
  );
  app.post<{ Params: { id: string } }>("/api/jobs/:id/cancel", async (request, reply) => {
    const result = await repos.requestCancel(request.params.id, "admin");
    if (result.status === "not_found") return reply.code(404).send({ error: "Job not found" });
    if (result.status === "not_cancelable") {
      return reply.code(409).send({ error: "Job is not cancelable", phase: result.phase });
    }
    return { ok: true, phase: "CancelRequested" };
  });
  app.post<{ Params: { id: string }; Body?: { guidance?: unknown } }>("/api/jobs/:id/retry", async (request, reply) => {
    // X4: an operator may attach a steering note. Normalize/validate up front so
    // a bad note is a 400 before any state change. Empty/whitespace → no guidance.
    const guidance = normalizeGuidance(request.body?.guidance);
    if (guidance === "invalid") {
      return reply.code(400).send({ error: `Guidance must be a string under ${MAX_GUIDANCE_LENGTH} characters` });
    }

    const preflight = await repos.getRetryPreflight(request.params.id);
    if (!preflight) return reply.code(404).send({ error: "Job not found" });
    // FailedInternal is always retryable (transient/internal failure). A
    // FailedActionable job (agent/policy quality failure) is only re-runnable
    // when the operator supplies guidance to steer the next attempt (X4) —
    // re-running the same snapshot unchanged would just fail the same way.
    const unlockedByGuidance = guidance !== null && isActionableFailure(preflight);
    if (preflight.retryable !== true && !unlockedByGuidance) {
      return reply.code(409).send({ error: "Job is not retryable", preflight });
    }
    let retry: { runId: string; attempt: number };
    try {
      retry = await repos.createRetryAttempt(request.params.id, "admin", { guidance });
    } catch (error) {
      if (isHttpError(error, 404)) return reply.code(404).send({ error: "Job not found" });
      if (isHttpError(error, 409)) return reply.code(409).send({ error: getErrorMessage(error) });
      throw error;
    }
    try {
      await queue.add(
        request.params.id,
        {
          jobId: request.params.id,
          runId: retry.runId,
          attempt: retry.attempt,
        },
        // X6: stable jobId dedups duplicate enqueues of the same attempt.
        { jobId: enqueueJobId(request.params.id, retry.runId) },
      );
    } catch (error) {
      const message = getErrorMessage(error);
      await repos.transitionJob(request.params.id, "Failed", "FailedInternal", message);
      await repos.appendEvent({
        jobId: request.params.id,
        runId: retry.runId,
        attempt: retry.attempt,
        phase: "Failed",
        eventType: "job.retry_enqueue_failed",
        source: "api",
        message,
      });
      return reply.code(503).send({ error: "Retry enqueue failed" });
    }
    return reply.code(202).send({ ok: true, runId: retry.runId, attempt: retry.attempt });
  });

  // NeedsInput resume: the operator answers the agent's blocking question. The
  // answer is injected as the new run's guidance (reusing the retry-with-guidance
  // plumbing), then the run is re-enqueued exactly like a retry. 409 when the job
  // is not parked on a question; 400 on an empty / over-long answer.
  app.post<{ Params: { id: string }; Body?: { answer?: unknown } }>("/api/jobs/:id/answer", async (request, reply) => {
    const answer = normalizeAnswer(request.body?.answer);
    if (answer === "invalid") {
      return reply.code(400).send({ error: `Answer must be a non-empty string under ${MAX_ANSWER_LENGTH} characters` });
    }

    let resumed: { runId: string; attempt: number };
    try {
      resumed = await repos.answerNeedsInput(request.params.id, answer, "admin");
    } catch (error) {
      if (isHttpError(error, 404)) return reply.code(404).send({ error: "Job not found" });
      // The repo's guard rejects any job that is not parked on a question (or a
      // double submit that already resumed it) with a 409.
      if (isHttpError(error, 409)) return reply.code(409).send({ error: "Job is not awaiting input" });
      throw error;
    }

    try {
      await queue.add(
        request.params.id,
        {
          jobId: request.params.id,
          runId: resumed.runId,
          attempt: resumed.attempt,
        },
        // X6: stable per-attempt jobId dedups a double-submitted resume.
        { jobId: enqueueJobId(request.params.id, resumed.runId) },
      );
    } catch (error) {
      const message = getErrorMessage(error);
      await repos.transitionJob(request.params.id, "Failed", "FailedInternal", message);
      await repos.appendEvent({
        jobId: request.params.id,
        runId: resumed.runId,
        attempt: resumed.attempt,
        phase: "Failed",
        eventType: "job.answer_enqueue_failed",
        source: "api",
        message,
      });
      return reply.code(503).send({ error: "Answer enqueue failed" });
    }
    return reply.code(202).send({ ok: true, runId: resumed.runId, attempt: resumed.attempt });
  });
}

function isHttpError(error: unknown, statusCode: number): boolean {
  return typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === statusCode;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

/**
 * Parses the optional `?days=N` metrics window. Returns `undefined` for an absent
 * value (all-time), a positive integer, or the literal `"invalid"` so the route
 * can answer 400 on a malformed value rather than silently defaulting.
 */
function parsePeriodDays(raw: string | undefined): number | undefined | "invalid" {
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return "invalid";
  return value;
}

/**
 * Normalizes operator retry guidance (X4). `undefined`/empty → `null` (no
 * guidance), a non-string or over-long value → `"invalid"` (400), otherwise the
 * trimmed note. Trimming keeps a whitespace-only note from unlocking a retry.
 */
function normalizeGuidance(raw: unknown): string | null | "invalid" {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return "invalid";
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_GUIDANCE_LENGTH) return "invalid";
  return trimmed;
}

/**
 * Normalizes an operator answer to a NeedsInput question. A non-string, empty /
 * whitespace-only, or over-long value → `"invalid"` (400); otherwise the trimmed
 * answer. Unlike guidance, an empty answer is invalid (you cannot "answer" with
 * nothing) — so empty maps to 400, not to a no-op.
 */
function normalizeAnswer(raw: unknown): string | "invalid" {
  if (typeof raw !== "string") return "invalid";
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "invalid";
  if (trimmed.length > MAX_ANSWER_LENGTH) return "invalid";
  return trimmed;
}

/** A FailedActionable job (agent/policy quality failure) that guidance can unlock. */
function isActionableFailure(preflight: RetryPreflightView): boolean {
  return preflight.outcome === "FailedActionable" && preflight.phase === "Failed";
}

/**
 * Stable BullMQ job id for an enqueue (X6). Keyed by jobId+runId so each retry
 * attempt is its own dedup unit: re-submitting the same attempt collapses, but a
 * genuinely new attempt (new runId) still enqueues.
 */
function enqueueJobId(jobId: string, runId: string): string {
  return `${jobId}:${runId}`;
}
