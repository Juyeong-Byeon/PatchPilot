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
 */
export function resolveExecutorMode(priority: Priority): ExecutorMode {
  return priority === "High" ? "staged" : "single-pass";
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
}

export interface ProcessAgentJobOptions {
  repos: WorkerRepositories;
  executor: Executor;
  publisher: Publisher;
  larkUpdater?: LarkStatusUpdater;
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
  executorModeOverride?: ExecutorMode;
  ids?: {
    runId?: () => string;
    artifactId?: (kind: string) => string;
    pullRequestId?: () => string;
  };
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
  | { status: "cancelled"; runId: string };

export async function processAgentJob(
  payload: AgentJobPayload,
  options: ProcessAgentJobOptions,
): Promise<ProcessAgentJobResult> {
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

  // Epic D / X3: route to a pipeline by priority (High → staged, else single-pass)
  // unless an explicit GSTACK_ARGS override is in effect. Recorded on the run so the
  // admin can read it back, and emitted as an event for the timeline.
  const executorMode = options.executorModeOverride ?? resolveExecutorMode(job.priority);

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
    lark?: { status: string; prUrl?: string; prNumber?: number; failureReason?: string },
    failure?: { category: FailureCategory; nextAction: string },
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
        appendLog: (log) => {
          detectStageBanners(log.text);
          return options.repos.appendLog({ jobId: job.jobId, runId: run.runId, ...log });
        },
        signal: abortController.signal,
      });
    } catch (error) {
      clearInterval(cancelPoll);
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

    if (result.status !== "completed") {
      const reason = result.failure?.message ?? `Agent result status: ${result.status}`;
      const outcome = result.retryable ? "FailedInternal" : "FailedActionable";
      await transitionJob(
        "Failed",
        outcome,
        reason,
        { status: outcome, failureReason: reason },
        failureDetails("agent", result.retryable ? NEXT_ACTION.infra : NEXT_ACTION.agent),
      );
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
  update: { status: string; prUrl?: string; prNumber?: number; failureReason?: string },
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

function phaseLabel(phase: InternalPhase): string {
  switch (phase) {
    case "Queued":
      return "대기";
    case "Planning":
      return "계획";
    case "Implementing":
      return "구현";
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
