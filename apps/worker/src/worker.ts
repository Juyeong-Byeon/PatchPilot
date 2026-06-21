import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  createArtifactId,
  createPrefixedId,
  createRunId,
  deriveOutcome,
  parseAgentResult,
  parseStageBanner,
} from "@ticket-to-pr/core";
import type { AgentResult, InternalPhase, LarkStatusUpdater, Priority, UserOutcome } from "@ticket-to-pr/core";
import type { AgentJobPayload } from "@ticket-to-pr/queue";
import { getWorkspacePaths } from "@ticket-to-pr/runner-contract";
import {
  evaluatePolicyGate,
  evaluatePreExecutionPolicy,
  type PolicyGateArtifact,
  type WorkerPolicyConfig,
} from "./policy-gate.js";
import { composePrBodyWithFooter } from "./pr-footer.js";
import type { PublishInput, PublishedPullRequest } from "./publisher-mock.js";

export interface WorkerJobRecord {
  jobId: string;
  ticketSnapshotId: string;
  larkRecordId: string;
  triggerVersion: string;
  title: string;
  description: string;
  definitionOfDone: string;
  repository: string;
  targetBranch: string;
  priority: Priority;
  phase: InternalPhase;
  outcome: UserOutcome;
  rawFields: Record<string, unknown>;
}

export interface WorkerRunRecord {
  runId: string;
  jobId?: string;
  attempt: number;
  workspacePath: string;
  workBranch: string;
}

/**
 * Which runner pipeline executes a job (epic D / X3). `staged` runs the
 * multi-stage gstack runner (plan/implement/review/qa) for higher-quality output;
 * `single-pass` runs the fast Codex single-pass runner. Recorded on the run and
 * surfaced to the admin so the chosen mode is observable.
 */
export type ExecutorMode = "single-pass" | "staged";

/**
 * Route a job to an executor mode by ticket `priority`: `High` → `staged`
 * (quality over cost), everything else → `single-pass` (fast default). A safe
 * default keeps an unspecified/unknown priority on the cheap single-pass path.
 *
 * `highPriorityStaged` is the live, operator-tunable Priority→staged mapping
 * (Settings page). When false, High is no longer routed to staged and every
 * priority takes the fast single-pass path. Defaults to true for back-compat so a
 * caller that omits it behaves exactly as before.
 */
export function resolveExecutorMode(priority: Priority, highPriorityStaged = true): ExecutorMode {
  return priority === "High" && highPriorityStaged ? "staged" : "single-pass";
}

export interface AppendExecutorLogInput {
  source: string;
  stream: "stdout" | "stderr" | "progress";
  sequence: number;
  text: string;
  redactionApplied?: boolean;
}

export interface ExecutorInput {
  job: WorkerJobRecord;
  run: WorkerRunRecord;
  /** Pipeline selected for this job (epic D). The gstack executor maps it to the runner entrypoint / GSTACK_ARGS. */
  executorMode: ExecutorMode;
  appendLog?: (input: AppendExecutorLogInput) => Promise<void>;
  /** Aborted when a cancel is requested mid-run so the executor can stop the runner. */
  signal?: AbortSignal;
  /**
   * Operator retry-guidance (X4) to steer this attempt. The gstack executor writes
   * it into the runner input context so the agent reads it alongside the ticket.
   * Undefined on first attempts / retries without guidance.
   */
  retryGuidance?: string | undefined;
  /**
   * EFFECTIVE per-job runner timeout in seconds (env ⊕ DB override; Settings page).
   * When set, the gstack executor uses it for THIS job so an operator's live override
   * applies without a worker restart. Undefined falls back to the executor's
   * startup-configured `options.timeoutSeconds` (back-compat).
   */
  jobTimeoutSeconds?: number;
}

// How often the worker polls for a cancel request while the runner executes.
const CANCEL_POLL_MS = 3000;
// Stage-note files the staged runner leaves in the workspace output dir, surfaced as artifacts.
const STAGE_NOTE_ARTIFACTS: ReadonlyArray<{ file: string; kind: string }> = [
  { file: "plan.md", kind: "gstack-plan" },
  { file: "review.md", kind: "gstack-review" },
  { file: "qa.md", kind: "gstack-qa" },
];

export type Executor = (input: ExecutorInput) => Promise<AgentResult>;
export type Publisher = (input: PublishInput) => Promise<PublishedPullRequest>;

export interface WorkerRepositories {
  getJobForWorker(jobId: string): Promise<WorkerJobRecord | null>;
  createRun(input: {
    id: string;
    jobId: string;
    attempt: number;
    workspacePath: string;
    workBranch: string;
    runnerImageDigest?: string | null;
    /** Persisted to runs.executor_mode so the admin can read which pipeline ran. */
    executorMode?: ExecutorMode | null;
  }): Promise<WorkerRunRecord>;
  transitionJob(
    jobId: string,
    phase: InternalPhase,
    outcome: UserOutcome,
    reason?: string,
    failure?: { category?: string | null; nextAction?: string | null },
  ): Promise<void>;
  /**
   * Optimistic, phase-guarded transition (T2 export). Returns `true` when a row was
   * updated and `false` when the guard rejected the write (job already advanced,
   * is terminal, or is not in `expectedFrom`). Optional so test doubles and older
   * repositories without it still satisfy the interface — the worker falls back to
   * the unguarded `transitionJob` when it is absent.
   */
  transitionJobGuarded?(
    jobId: string,
    phase: InternalPhase,
    outcome: UserOutcome,
    reason?: string,
    failure?: { category?: string | null; nextAction?: string | null },
    expectedFrom?: InternalPhase | InternalPhase[],
  ): Promise<boolean>;
  /**
   * Park the job on a human question (NeedsInput). One atomic, phase-guarded write
   * that moves the job to phase=AwaitingInput / outcome=NeedsInput AND persists the
   * agent's `question` to jobs.pending_question. Returns `true` when a row was
   * updated, `false` when the guard rejected it (already advanced / terminal /
   * not in `expectedFrom`). Optional so test doubles and older repositories without
   * it still satisfy the interface — when absent the worker falls back to the
   * unguarded `transitionJob` (the question is then carried only on the event).
   */
  parkAwaitingInput?(jobId: string, question: string, expectedFrom?: InternalPhase | InternalPhase[]): Promise<boolean>;
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
  appendLog(input: {
    jobId: string;
    runId?: string;
    source: string;
    stream: string;
    sequence: number;
    redactionApplied?: boolean;
    text: string;
  }): Promise<void>;
  saveArtifact(input: {
    id: string;
    jobId: string;
    runId?: string;
    kind: string;
    path?: string | null;
    content?: unknown;
  }): Promise<void>;
  savePullRequest(input: {
    id: string;
    jobId: string;
    runId: string;
    repository: string;
    targetBranch: string;
    workBranch: string;
    baseSha: string;
    headSha: string;
    commitShas: string[];
    prUrl: string;
    prNumber: number;
    prTitle: string;
    prBody: string;
  }): Promise<void>;
  appendAuditEvent(input: {
    actor: string;
    action: string;
    jobId?: string;
    runId?: string;
    metadata?: unknown;
  }): Promise<void>;
  /**
   * Bump the run's heartbeat timestamp (L1). Optional so test doubles and older
   * repositories without it still satisfy the interface; the worker simply skips
   * heartbeats when it is absent. Injected by index.ts as a raw `update runs set
   * heartbeat_at=now()` over the existing pool.
   */
  touchRunHeartbeat?(runId: string): Promise<void>;
  /**
   * Read the persisted setting overrides (Settings page). Optional so test doubles
   * and older repositories without it still satisfy the interface; index.ts uses it
   * to resolve the EFFECTIVE per-job settings. The worker accesses it only through
   * the injected `loadJobSettings` callback, never directly.
   */
  getAppSettings?(): Promise<Record<string, unknown>>;
}

export interface ProcessAgentJobOptions {
  repos: WorkerRepositories;
  executor: Executor;
  publisher: Publisher;
  larkUpdater?: LarkStatusUpdater | undefined;
  policyConfig: WorkerPolicyConfig;
  workspaceRoot?: string;
  /** Cancel-poll cadence while the runner executes (overridable for tests). */
  cancelPollMs?: number;
  /**
   * Forces the executor mode regardless of priority (epic D back-compat). Set by
   * index.ts when `GSTACK_ARGS` is explicitly present in env so an operator's
   * explicit pipeline choice still wins. When omitted, mode is derived from the
   * job's priority via {@link resolveExecutorMode}.
   */
  executorModeOverride?: ExecutorMode | undefined;
  /**
   * Execution dedup hook (X6). When provided, the worker acquires a per-job lock
   * before doing any work; if the lock is already held (a redelivered/duplicate
   * delivery while another worker is still processing the same job), it no-ops
   * instead of launching a second runner/PR. Injected by index.ts as a Postgres
   * advisory lock over the existing pool. Omitted by test doubles and the mock
   * worker, which then run without dedup (single-processor assumption).
   */
  acquireExecutionLock?: (jobId: string) => Promise<{ acquired: boolean; release(): Promise<void> }>;
  /**
   * GC the job's workspace after a successful publish (L1). Best-effort; injected by
   * index.ts. Omitted in tests that assert on the workspace contents.
   */
  gcWorkspaceOnSuccess?: (jobId: string) => Promise<void>;
  /** Run-heartbeat cadence while the runner executes (L1). 0/undefined disables. */
  heartbeatIntervalMs?: number;
  /**
   * Resolve the EFFECTIVE per-job settings (env ⊕ DB override; Settings page) once at
   * the start of THIS job. Injected by index.ts as a read of `repos.getAppSettings()`
   * merged with env. When omitted (test doubles, mock worker) the worker uses the
   * startup env defaults, so behavior with no overrides is identical to today.
   */
  loadJobSettings?: () => Promise<EffectiveJobSettings>;
  ids?: {
    runId?: () => string;
    artifactId?: (kind: string) => string;
    pullRequestId?: () => string;
  };
}

/**
 * EFFECTIVE per-job settings resolved from env ⊕ DB override (Settings page). Read
 * once at the start of each job so a live override applies without a redeploy.
 */
export interface EffectiveJobSettings {
  /** Runner timeout in seconds for this job. */
  jobTimeoutSeconds: number;
  /** Whether Priority=High routes to the staged pipeline. */
  highPriorityStaged: boolean;
}

export type FailureCategory = "policy" | "agent" | "publish" | "infra";

// Operator-facing remediation hints, written to jobs.next_action so the admin
// console can show "what to do next" for every failure. Korean-first to match
// the worker progress logs and the primary operations audience.
const NEXT_ACTION: Record<FailureCategory, string> = {
  policy: "정책 위반 사항(저장소 허용 목록·보호 경로·대상 브랜치·검증 증거)을 해결한 뒤 티켓을 다시 승인하세요.",
  agent: "티켓 설명과 완료 조건(DoD)을 보완한 뒤 티켓을 다시 승인하세요.",
  publish: "대상 저장소 권한과 브랜치 충돌 여부를 확인한 뒤 관리자 콘솔에서 재시도하세요.",
  infra: "일시적 인프라 오류일 수 있습니다. 관리자 콘솔에서 재시도하세요.",
};

function failureDetails(
  category: FailureCategory,
  nextAction = NEXT_ACTION[category],
): {
  category: FailureCategory;
  nextAction: string;
} {
  return { category, nextAction };
}

export type ProcessAgentJobResult =
  | { status: "completed"; runId: string }
  | { status: "failed"; runId: string }
  | { status: "policy_blocked"; runId: string }
  | { status: "cancelled"; runId: string }
  // NeedsInput: the agent asked a blocking question and the job is PARKED at
  // AwaitingInput/NeedsInput (no PR). It resumes when an operator answers.
  | { status: "needs_input"; runId: string }
  // X6 execution dedup: another worker already holds this job's lock, so this
  // (redelivered) delivery did no work. No run is created.
  | { status: "dedup_skipped" };

export async function processAgentJob(
  payload: AgentJobPayload,
  options: ProcessAgentJobOptions,
): Promise<ProcessAgentJobResult> {
  // X6: take the per-job execution lock first. If another worker is already
  // processing this job (crash redelivery / stalled-job requeue / duplicate
  // enqueue that slipped past jobId dedup), no-op instead of launching a second
  // runner and creating a duplicate PR. The lock is released in `finally`.
  const lock = options.acquireExecutionLock ? await options.acquireExecutionLock(payload.jobId) : undefined;
  if (lock && !lock.acquired) {
    return { status: "dedup_skipped" };
  }
  try {
    return await runAgentJob(payload, options);
  } finally {
    if (lock) await lock.release();
  }
}

async function runAgentJob(payload: AgentJobPayload, options: ProcessAgentJobOptions): Promise<ProcessAgentJobResult> {
  const job = await options.repos.getJobForWorker(payload.jobId);
  if (!job) throw new Error(`Job not found: ${payload.jobId}`);
  if (payload.ticketSnapshotId && job.ticketSnapshotId !== payload.ticketSnapshotId) {
    throw new Error(`Ticket snapshot mismatch for job ${payload.jobId}`);
  }

  const runId = payload.runId ?? options.ids?.runId?.() ?? createRunId();
  const attempt = payload.attempt ?? 1;
  const artifactId = options.ids?.artifactId ?? (() => createArtifactId());
  const pullRequestId = options.ids?.pullRequestId ?? (() => createPrefixedId("pr"));
  const workBranch = createAttemptWorkBranch(job.jobId, attempt);
  const workspacePath = join(options.workspaceRoot ?? "/tmp/ticket-to-pr-worker", job.jobId, runId);
  await mkdir(workspacePath, { recursive: true });

  // Settings page: resolve the EFFECTIVE per-job settings (env ⊕ DB override) once
  // for this job so a live override applies without a worker restart. With no
  // overrides present this returns the startup env defaults — behavior identical to
  // today. Best-effort: a failed load falls back to defaults so settings reads never
  // fail a job.
  const jobSettings = await loadJobSettings(options);

  // Epic D / X3: route to a pipeline by priority (High → staged, else single-pass)
  // unless an explicit GSTACK_ARGS override is in effect. The Priority→staged mapping
  // honors the live `highPriorityStaged` override. Recorded on the run so the admin
  // can read it back, and emitted as an event for the timeline.
  const executorMode =
    options.executorModeOverride ?? resolveExecutorMode(job.priority, jobSettings.highPriorityStaged);

  // X4: operator retry-guidance to steer this attempt. Prefer the explicit payload
  // field (set by the api track on retry); fall back to a `retryGuidance` string in
  // the ticket's rawFields so the worker works even before the api track stamps the
  // payload. Forward-compatible: undefined when neither is present.
  const retryGuidance = resolveRetryGuidance(payload, job);

  const run = await options.repos.createRun({
    id: runId,
    jobId: job.jobId,
    attempt,
    workspacePath,
    workBranch,
    executorMode,
  });

  let progressSequence = 0;
  const appendEvent = (
    phase: InternalPhase,
    eventType: string,
    message: string,
    metadata?: unknown,
    source = "worker",
  ) =>
    options.repos.appendEvent({
      jobId: job.jobId,
      runId: run.runId,
      attempt: run.attempt,
      phase,
      eventType,
      source,
      message,
      metadata,
    });
  const appendProgressLog = (phase: InternalPhase, source: string, message: string) =>
    options.repos.appendLog({
      jobId: job.jobId,
      runId: run.runId,
      source,
      stream: "progress",
      sequence: progressSequence++,
      text: `[${phaseLabel(phase)}] ${message}`,
    });
  const transitionJob = async (
    phase: InternalPhase,
    outcome: UserOutcome,
    reason?: string,
    lark?: { status: string; prUrl?: string; prNumber?: number; failureReason?: string | undefined },
    // `category` widened to string so a runner's STRUCTURED failure category (X4)
    // passes through unchanged; the underlying repo column is free-form text.
    failure?: { category: FailureCategory | string; nextAction: string },
  ) => {
    if (failure !== undefined) {
      await options.repos.transitionJob(job.jobId, phase, outcome, reason, failure);
    } else if (reason === undefined) {
      await options.repos.transitionJob(job.jobId, phase, outcome);
    } else {
      await options.repos.transitionJob(job.jobId, phase, outcome, reason);
    }
    if (lark) await syncLarkStatus(options.larkUpdater, job, lark);
  };

  try {
    if (await isCancelRequested(options.repos, job.jobId)) {
      await transitionJob("Cancelled", "Cancelled", undefined, { status: "Cancelled" });
      await appendEvent("Cancelled", "worker.cancelled", "Worker stopped before execution");
      return { status: "cancelled", runId: run.runId };
    }

    const preExecutionGate = evaluatePreExecutionPolicy({
      repository: job.repository,
      repositoryAllowlist: options.policyConfig.repositoryAllowlist,
      protectedPathDenylist: options.policyConfig.protectedPathDenylist,
      expectedTargetBranch: job.targetBranch,
    });
    if (!preExecutionGate.allowed) {
      await options.repos.saveArtifact({
        id: artifactId("policy-gate-pre-execution"),
        jobId: job.jobId,
        runId: run.runId,
        kind: "policy-gate",
        content: preExecutionGate.artifact,
      });
      await transitionJob(
        "Failed",
        "FailedActionable",
        preExecutionGate.reason,
        {
          status: "FailedActionable",
          failureReason: preExecutionGate.reason,
        },
        failureDetails("policy"),
      );
      await appendEvent(
        "Failed",
        "policy.blocked",
        preExecutionGate.reason ?? "Pre-execution policy gate blocked job",
        preExecutionGate.artifact,
      );
      return { status: "policy_blocked", runId: run.runId };
    }

    await transitionJob("Planning", deriveOutcome("Planning"), undefined, { status: "Running" });
    await appendEvent("Planning", "worker.started", "Worker picked up job");
    await appendEvent("Planning", "worker.executor_mode", `Executor mode: ${executorMode} (priority=${job.priority})`, {
      executorMode,
      priority: job.priority,
      overridden: options.executorModeOverride !== undefined,
    });
    await appendProgressLog("Planning", "worker", "작업자가 티켓과 저장소 정책을 확인하고 있습니다.");
    if (retryGuidance) {
      // X4: record that operator steering is being applied to this attempt. The
      // guidance text itself is part of the runner input context (written by the
      // executor); the event makes the steering auditable on the timeline.
      await appendEvent("Planning", "worker.retry_guidance", "Operator retry guidance applied to this attempt", {
        attempt: run.attempt,
      });
    }

    await transitionJob("Implementing", deriveOutcome("Implementing"));
    await appendEvent("Implementing", "runner.started", "AI runner started", undefined, "gstack");
    await appendProgressLog("Implementing", "gstack", "실행 워크스페이스를 준비하고 AI runner를 시작합니다.");

    // Watch for a cancel request while the (long-running) runner executes and abort it.
    const abortController = new AbortController();
    const cancelPoll = setInterval(() => {
      void isCancelRequested(options.repos, job.jobId)
        .then((requested) => {
          if (requested) abortController.abort();
        })
        .catch(() => undefined);
    }, options.cancelPollMs ?? CANCEL_POLL_MS);

    // L1: periodically bump the run heartbeat while the runner executes so a long
    // but healthy run is distinguishable from a stuck/dead one. Best-effort.
    const heartbeatInterval = options.heartbeatIntervalMs ?? 0;
    const heartbeatPoll =
      heartbeatInterval > 0 && options.repos.touchRunHeartbeat
        ? setInterval(() => {
            void options.repos.touchRunHeartbeat?.(run.runId).catch(() => undefined);
          }, heartbeatInterval)
        : undefined;
    const stopHeartbeat = () => {
      if (heartbeatPoll) clearInterval(heartbeatPoll);
    };

    // Detect the staged runner's per-stage banners in the streamed stdout and record
    // each as a structured `gstack.stage` event (line-buffered so a banner split across
    // log chunks is never missed). This keeps the job in Implementing — it is sub-stage
    // telemetry, not a phase change — and gives the admin a robust, replayable signal.
    let stageBuffer = "";
    const seenStageIndexes = new Set<number>();
    let stageEventChain: Promise<void> = Promise.resolve();
    const detectStageBanners = (text: string | undefined) => {
      if (!text) return;
      stageBuffer += text;
      const lines = stageBuffer.split("\n");
      stageBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const banner = parseStageBanner(line);
        if (!banner || seenStageIndexes.has(banner.index)) continue;
        seenStageIndexes.add(banner.index);
        stageEventChain = stageEventChain
          .then(() =>
            appendEvent(
              "Implementing",
              "gstack.stage",
              `gstack stage ${banner.index}/${banner.total}: ${banner.key}`,
              { stageIndex: banner.index, stageTotal: banner.total, stageKey: banner.key },
              "gstack",
            ),
          )
          .catch(() => undefined);
      }
    };

    let rawResult: AgentResult;
    try {
      rawResult = await options.executor({
        job,
        run,
        executorMode,
        retryGuidance,
        // EFFECTIVE per-job timeout (env ⊕ override); the gstack executor prefers this
        // over its startup-configured timeout so an override applies live.
        jobTimeoutSeconds: jobSettings.jobTimeoutSeconds,
        appendLog: (log) => {
          detectStageBanners(log.text);
          return options.repos.appendLog({ jobId: job.jobId, runId: run.runId, ...log });
        },
        signal: abortController.signal,
      });
    } catch (error) {
      clearInterval(cancelPoll);
      stopHeartbeat();
      await stageEventChain;
      if (abortController.signal.aborted) {
        // Cancelled mid-run: record where it stopped and tidy up (the runner container is killed).
        await transitionJob("Cancelled", "Cancelled", "구현 단계 실행 중 취소되었습니다.", { status: "Cancelled" });
        await appendEvent("Cancelled", "worker.cancelled", "Runner cancelled during execution", {
          cancelledPhase: "Implementing",
        });
        await appendProgressLog("Cancelled", "worker", "실행 중 취소 요청을 감지해 러너를 중단했습니다.");
        return { status: "cancelled", runId: run.runId };
      }
      throw error;
    }
    clearInterval(cancelPoll);
    stopHeartbeat();
    detectStageBanners("\n");
    await stageEventChain;

    const result = parseAgentResult(rawResult);
    await appendProgressLog("Implementing", "gstack", "AI runner 결과를 수집하고 있습니다.");
    await options.repos.saveArtifact({
      id: artifactId("agent-result"),
      jobId: job.jobId,
      runId: run.runId,
      kind: "agent-result",
      content: result,
    });
    await persistStageNotes(options.repos, artifactId, job.jobId, run);

    if (await isCancelRequested(options.repos, job.jobId)) {
      await transitionJob("Cancelled", "Cancelled", undefined, { status: "Cancelled" });
      await appendEvent("Cancelled", "worker.cancelled", "Worker stopped before policy check");
      return { status: "cancelled", runId: run.runId };
    }

    // NeedsInput: the agent asked one blocking question only a human can answer.
    // This is a CLEAN STOP, not a failure — park the job (no PR, no failure
    // category), persist the question, and surface it to the operator. The answer
    // (entered in the console) re-queues the job exactly like a retry-with-guidance.
    if (result.status === "needs_input") {
      const question = result.question ?? "The agent needs clarification to proceed.";
      const parked = await parkJobAwaitingInput(options.repos, job.jobId, question);
      if (!parked) {
        // A concurrent cancel/terminal write won the race; do not overwrite it.
        await appendEvent("Implementing", "worker.needs_input_skipped", "Needs-input park rejected by guard", {
          attempt: run.attempt,
        });
        return { status: "failed", runId: run.runId };
      }
      await syncLarkStatus(options.larkUpdater, job, {
        status: "NeedsInput",
        failureReason: summarizeQuestion(question),
      });
      await appendEvent("AwaitingInput", "job.needs_input", question, { attempt: run.attempt }, "worker");
      await appendProgressLog("AwaitingInput", "worker", "에이전트가 사람의 결정을 요청해 작업을 일시 중지했습니다.");
      return { status: "needs_input", runId: run.runId };
    }

    if (result.status !== "completed") {
      // X4: honor the runner's STRUCTURED failure when present (output/failure.json →
      // result.failure). Surface its message, category, and nextAction instead of the
      // canned worker text so the operator sees the runner's own diagnosis. Tolerant
      // of absence (forward-compatible): when failure is null we fall back to the
      // generic agent/infra remediation as before.
      const structured = result.failure;
      const reason = structured?.message ?? `Agent result status: ${result.status}`;
      const outcome = result.retryable ? "FailedInternal" : "FailedActionable";
      const failure = structured
        ? { category: structured.category, nextAction: structured.nextAction }
        : failureDetails("agent", result.retryable ? NEXT_ACTION.infra : NEXT_ACTION.agent);
      await transitionJob("Failed", outcome, reason, { status: outcome, failureReason: reason }, failure);
      await appendEvent("Failed", "worker.failed", reason, result.failure);
      return { status: "failed", runId: run.runId };
    }

    await transitionJob("PolicyChecking", deriveOutcome("PolicyChecking"));
    await appendEvent("PolicyChecking", "policy.started", "Policy gate started", undefined, "policy");
    await appendProgressLog("PolicyChecking", "policy", "변경 파일과 저장소 허용 정책을 검사하고 있습니다.");
    const gate = evaluatePolicyGate(result, {
      repository: job.repository,
      repositoryAllowlist: options.policyConfig.repositoryAllowlist,
      protectedPathDenylist: options.policyConfig.protectedPathDenylist,
      expectedTargetBranch: job.targetBranch,
    });
    await options.repos.saveArtifact({
      id: artifactId("policy-gate"),
      jobId: job.jobId,
      runId: run.runId,
      kind: "policy-gate",
      content: gate.artifact,
    });
    if (!gate.allowed) {
      await transitionJob(
        "Failed",
        "FailedActionable",
        gate.reason,
        { status: "FailedActionable", failureReason: gate.reason },
        failureDetails("policy"),
      );
      await appendEvent("Failed", "policy.blocked", gate.reason ?? "Policy gate blocked result", gate.artifact);
      return { status: "policy_blocked", runId: run.runId };
    }

    // Cancellation check immediately before Publishing. Once we enter Publishing we
    // commit to it: core's whitelist gives Publishing no path to Cancelled, and a
    // half-pushed branch must not be abandoned mid-flight. The optimistic guard
    // (expectedFrom=PolicyChecking) is the atomic gate — if a cancel flipped the job
    // to CancelRequested between the read and here, the guarded transition no-ops
    // (rowCount 0) and we stop instead of publishing.
    if (await isCancelRequested(options.repos, job.jobId)) {
      await transitionJob("Cancelled", "Cancelled", undefined, { status: "Cancelled" });
      await appendEvent("Cancelled", "worker.cancelled", "Worker stopped before publishing");
      return { status: "cancelled", runId: run.runId };
    }

    const enteredPublishing = await guardedTransition(
      options.repos,
      job.jobId,
      "Publishing",
      deriveOutcome("Publishing"),
      {
        expectedFrom: "PolicyChecking",
      },
    );
    if (!enteredPublishing) {
      // The guard rejected the advance: a concurrent cancel (or terminal write) won
      // the race. Treat as cancelled — do not publish.
      await appendEvent("Cancelled", "worker.cancelled", "Cancel won the race before Publishing", {
        cancelledPhase: "PolicyChecking",
      });
      return { status: "cancelled", runId: run.runId };
    }
    await syncLarkStatus(options.larkUpdater, job, { status: "Running" });
    await appendEvent("Publishing", "publisher.started", "Publisher started", undefined, "publisher");
    await appendProgressLog("Publishing", "publisher", "브랜치를 푸시하고 PR을 생성하고 있습니다.");
    const published = await options.publisher(await createPublishInput(job, run, result, gate.artifact));
    await options.repos.savePullRequest({
      id: pullRequestId(),
      jobId: job.jobId,
      runId: run.runId,
      ...published,
    });
    await options.repos.appendAuditEvent({
      actor: "worker",
      action: "pull_request.created",
      jobId: job.jobId,
      runId: run.runId,
      metadata: { prUrl: published.prUrl, prNumber: published.prNumber },
    });
    await transitionJob("Completed", deriveOutcome("Completed"), undefined, {
      status: "NeedsReview",
      prUrl: published.prUrl,
      prNumber: published.prNumber,
    });
    await appendEvent("Completed", "worker.completed", "Worker completed job", { prUrl: published.prUrl });
    await appendProgressLog("Completed", "worker", "PR 생성이 끝났습니다.");
    // L1: GC the workspace now that the PR is published — a completed job is never
    // retried, so its checkout/output is no longer needed. Best-effort, never fails
    // the job.
    if (options.gcWorkspaceOnSuccess) await options.gcWorkspaceOnSuccess(job.jobId).catch(() => undefined);
    return { status: "completed", runId: run.runId };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown worker error";
    await transitionJob(
      "Failed",
      "FailedInternal",
      message,
      { status: "FailedInternal", failureReason: message },
      failureDetails("infra"),
    );
    await appendEvent("Failed", "worker.error", message);
    return { status: "failed", runId: run.runId };
  }
}

async function syncLarkStatus(
  larkUpdater: LarkStatusUpdater | undefined,
  job: WorkerJobRecord,
  update: { status: string; prUrl?: string; prNumber?: number; failureReason?: string | undefined },
): Promise<void> {
  if (!larkUpdater) return;
  try {
    await larkUpdater({
      recordId: job.larkRecordId,
      status: update.status,
      jobId: job.jobId,
      prUrl: update.prUrl,
      prNumber: update.prNumber,
      failureReason: update.failureReason,
    });
  } catch {
    // Lark write-back must not fail the platform-owned job execution.
  }
}

async function isCancelRequested(repos: Pick<WorkerRepositories, "getJobForWorker">, jobId: string): Promise<boolean> {
  const latest = await repos.getJobForWorker(jobId);
  return latest?.phase === "CancelRequested" || latest?.phase === "Cancelling";
}

/**
 * Phase-guarded transition for the worker (epic C). Uses the T2 `transitionJobGuarded`
 * export when the repository provides it (the real one always does), returning its
 * `rowCount===1` signal. When absent (legacy test doubles) it falls back to the
 * unguarded `transitionJob` and reports success so behavior is unchanged.
 */
async function guardedTransition(
  repos: Pick<WorkerRepositories, "transitionJob" | "transitionJobGuarded">,
  jobId: string,
  phase: InternalPhase,
  outcome: UserOutcome,
  options: { expectedFrom?: InternalPhase | InternalPhase[]; reason?: string } = {},
): Promise<boolean> {
  if (repos.transitionJobGuarded) {
    return repos.transitionJobGuarded(jobId, phase, outcome, options.reason, undefined, options.expectedFrom);
  }
  await repos.transitionJob(jobId, phase, outcome, options.reason);
  return true;
}

/**
 * Park a job on a human question (NeedsInput) via the phase-guarded path. Prefers
 * the dedicated `parkAwaitingInput` repo method (the real one persists the question
 * to jobs.pending_question atomically with the AwaitingInput/NeedsInput transition,
 * `expectedFrom` = the running phases so a concurrent cancel/terminal write cannot
 * be clobbered). Falls back to the unguarded `transitionJob` for legacy test doubles
 * (the question is then carried only on the emitted event), reporting success so
 * behavior is unchanged. Returns whether the job was parked.
 */
async function parkJobAwaitingInput(
  repos: Pick<WorkerRepositories, "transitionJob" | "parkAwaitingInput">,
  jobId: string,
  question: string,
): Promise<boolean> {
  if (repos.parkAwaitingInput) {
    // Only a still-running job may be parked; a job that already settled
    // (cancelled/failed) or advanced must not be silently overwritten.
    return repos.parkAwaitingInput(jobId, question, ["Queued", "Planning", "Implementing", "Reviewing", "Testing"]);
  }
  await repos.transitionJob(jobId, "AwaitingInput", "NeedsInput");
  return true;
}

// Lark write-back of the question keeps the cell readable; long questions are
// truncated so the status field stays a one-line summary.
const QUESTION_SUMMARY_MAX = 280;
export function summarizeQuestion(question: string): string {
  const trimmed = question.trim();
  return trimmed.length > QUESTION_SUMMARY_MAX ? `${trimmed.slice(0, QUESTION_SUMMARY_MAX - 1)}…` : trimmed;
}

// Surface the staged runner's plan/review/qa notes (written to the workspace output
// dir) as admin artifacts. Best-effort: single-pass/mock runs have no notes -> no-op.
async function persistStageNotes(
  repos: Pick<WorkerRepositories, "saveArtifact">,
  artifactId: (kind: string) => string,
  jobId: string,
  run: WorkerRunRecord,
): Promise<void> {
  const outputDir = getWorkspacePaths(run.workspacePath).outputDir;
  for (const note of STAGE_NOTE_ARTIFACTS) {
    const content = await readFile(join(outputDir, note.file), "utf8").catch(() => "");
    if (!content.trim()) continue;
    await repos
      .saveArtifact({ id: artifactId(note.kind), jobId, runId: run.runId, kind: note.kind, path: note.file, content })
      .catch(() => undefined);
  }
}

async function createPublishInput(
  job: WorkerJobRecord,
  run: WorkerRunRecord,
  result: AgentResult,
  policyArtifact: PolicyGateArtifact,
): Promise<PublishInput> {
  if (
    result.status !== "completed" ||
    !result.baseSha ||
    !result.headSha ||
    !result.pushSha ||
    !result.targetBranch ||
    !result.pullRequestDraft
  ) {
    throw new Error("Completed AgentResult is missing publish fields");
  }

  const agentBody = await readPullRequestDraftBody(run.workspacePath, result.pullRequestDraft.bodyPath);
  // N1: append the platform-owned trust footer below the agent-authored body. All
  // footer data is drawn from the trusted git evidence (baseSha/headSha already
  // overwritten by the executor's collectTrustedGitEvidence), the policy-gate
  // verdict, and DB-owned ids/DoD — never from agent-reported values.
  const body = composePrBodyWithFooter(agentBody, {
    larkRecordId: job.larkRecordId,
    jobId: job.jobId,
    runId: run.runId,
    repository: job.repository,
    targetBranch: result.targetBranch,
    workBranch: run.workBranch,
    baseSha: result.baseSha,
    headSha: result.headSha,
    definitionOfDone: job.definitionOfDone,
    policy: policyArtifact,
    tests: result.tests,
  });

  return {
    jobId: job.jobId,
    runId: run.runId,
    repository: job.repository,
    targetBranch: result.targetBranch,
    workBranch: run.workBranch,
    localRepoDir: getWorkspacePaths(run.workspacePath).repoDir,
    baseSha: result.baseSha,
    headSha: result.headSha,
    pushSha: result.pushSha,
    commitShas: result.commits.map((commit) => commit.sha),
    title: result.pullRequestDraft.title,
    body,
  };
}

export function createAttemptWorkBranch(jobId: string, attempt: number): string {
  return attempt > 1 ? `ticket-to-pr/${jobId}-attempt-${attempt}` : `ticket-to-pr/${jobId}`;
}

// Registry-aligned fallbacks used when no settings loader is injected (test doubles,
// mock worker) or when the loader fails. Mirror env.ts defaults.
const DEFAULT_JOB_TIMEOUT_SECONDS = 3600;
const DEFAULT_HIGH_PRIORITY_STAGED = true;

/**
 * Resolve the EFFECTIVE per-job settings for this job. Calls the injected loader
 * (index.ts reads getAppSettings() ⊕ env) once; on absence or failure falls back to
 * the registry-aligned defaults so a settings read never fails the job and the
 * no-override path is identical to today.
 */
async function loadJobSettings(options: ProcessAgentJobOptions): Promise<EffectiveJobSettings> {
  if (!options.loadJobSettings) {
    return { jobTimeoutSeconds: DEFAULT_JOB_TIMEOUT_SECONDS, highPriorityStaged: DEFAULT_HIGH_PRIORITY_STAGED };
  }
  try {
    return await options.loadJobSettings();
  } catch {
    return { jobTimeoutSeconds: DEFAULT_JOB_TIMEOUT_SECONDS, highPriorityStaged: DEFAULT_HIGH_PRIORITY_STAGED };
  }
}

/**
 * Resolve operator retry-guidance (X4) for this attempt. Prefers the explicit
 * payload field set by the api track on retry; falls back to a non-empty
 * `retryGuidance` string in the ticket's rawFields so the worker is useful even
 * before the api track stamps the payload. Returns undefined when neither carries
 * usable guidance (forward-compatible — never throws on a missing field).
 */
export function resolveRetryGuidance(payload: AgentJobPayload, job: WorkerJobRecord): string | undefined {
  const fromPayload = typeof payload.retryGuidance === "string" ? payload.retryGuidance.trim() : "";
  if (fromPayload) return fromPayload;
  const rawValue = job.rawFields?.retryGuidance;
  const fromRaw = typeof rawValue === "string" ? rawValue.trim() : "";
  return fromRaw ? fromRaw : undefined;
}

function phaseLabel(phase: InternalPhase): string {
  switch (phase) {
    case "Queued":
      return "대기";
    case "Planning":
      return "계획";
    case "Implementing":
      return "구현";
    case "AwaitingInput":
      return "입력 대기";
    case "PolicyChecking":
      return "정책 검사";
    case "Publishing":
      return "게시";
    case "Completed":
      return "완료";
    case "Failed":
      return "실패";
    case "CancelRequested":
      return "취소 요청";
    case "Cancelling":
      return "취소 중";
    case "Cancelled":
      return "취소됨";
    default:
      return phase;
  }
}

async function readPullRequestDraftBody(workspacePath: string, bodyPath: string): Promise<string> {
  const workspaceRoot = resolve(workspacePath);
  const resolvedBodyPath = isAbsolute(bodyPath) ? resolve(bodyPath) : resolve(workspaceRoot, bodyPath);
  if (resolvedBodyPath !== workspaceRoot && !resolvedBodyPath.startsWith(`${workspaceRoot}${sep}`)) {
    throw new Error("Pull request body path must stay inside the job workspace");
  }

  try {
    return await readFile(resolvedBodyPath, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      throw new Error(`Missing pull request body artifact: ${bodyPath}`);
    }
    throw error;
  }
}
