import type { AgentJobPayload } from "@ticket-to-pr/queue";
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
  createRetryAttempt(jobId: string, actor: string): Promise<{ runId: string; attempt: number }>;
}

export interface RetryPreflightView {
  retryable: boolean;
}

export type CancelRequestView =
  | { status: "requested" }
  | { status: "not_found" }
  | { status: "not_cancelable"; phase?: string };

export interface AdminQueue {
  add(name: string, data: AgentJobPayload): Promise<unknown>;
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  repos: AdminRepositories,
  queue: AdminQueue,
  adminToken: string
): Promise<void> {
  app.addHook("preHandler", async (request) => {
    if (request.url.startsWith("/api/jobs")) assertAdminToken(request, adminToken);
  });

  app.get("/api/jobs", async () => repos.listJobs());
  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (request, reply) => {
    const job = await repos.getJob(request.params.id);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    return job;
  });
  app.get<{ Params: { id: string } }>("/api/jobs/:id/events", async (request) =>
    repos.getJobEvents(request.params.id)
  );
  app.get<{ Params: { id: string } }>("/api/jobs/:id/logs", async (request) =>
    repos.getJobLogs(request.params.id)
  );
  app.get<{ Params: { id: string } }>("/api/jobs/:id/artifacts", async (request) =>
    repos.getJobArtifacts(request.params.id)
  );
  app.post<{ Params: { id: string } }>("/api/jobs/:id/cancel", async (request, reply) => {
    const result = await repos.requestCancel(request.params.id, "admin");
    if (result.status === "not_found") return reply.code(404).send({ error: "Job not found" });
    if (result.status === "not_cancelable") {
      return reply.code(409).send({ error: "Job is not cancelable", phase: result.phase });
    }
    return { ok: true, phase: "CancelRequested" };
  });
  app.post<{ Params: { id: string } }>("/api/jobs/:id/retry", async (request, reply) => {
    const preflight = await repos.getRetryPreflight(request.params.id);
    if (!preflight) return reply.code(404).send({ error: "Job not found" });
    if (preflight.retryable !== true) {
      return reply.code(409).send({ error: "Job is not retryable", preflight });
    }
    const retry = await repos.createRetryAttempt(request.params.id, "admin");
    await queue.add(request.params.id, {
      jobId: request.params.id,
      runId: retry.runId,
      attempt: retry.attempt
    });
    return reply.code(202).send({ ok: true, runId: retry.runId, attempt: retry.attempt });
  });
}
