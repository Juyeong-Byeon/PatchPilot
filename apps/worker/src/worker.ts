import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { createArtifactId, createPrefixedId, createRunId, deriveOutcome, parseAgentResult } from "@ticket-to-pr/core";
import type { AgentResult, InternalPhase, LarkStatusUpdater, Priority, UserOutcome } from "@ticket-to-pr/core";
import type { AgentJobPayload } from "@ticket-to-pr/queue";
import { getWorkspacePaths } from "@ticket-to-pr/runner-contract";
import { evaluatePolicyGate, evaluatePreExecutionPolicy, type WorkerPolicyConfig } from "./policy-gate.js";
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
  appendLog?: (input: AppendExecutorLogInput) => Promise<void>;
}

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
  }): Promise<WorkerRunRecord>;
  transitionJob(
    jobId: string,
    phase: InternalPhase,
    outcome: UserOutcome,
    reason?: string,
    failure?: { category?: string | null; nextAction?: string | null }
  ): Promise<void>;
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
  saveArtifact(input: { id: string; jobId: string; runId?: string; kind: string; path?: string | null; content?: unknown }): Promise<void>;
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
  appendAuditEvent(input: { actor: string; action: string; jobId?: string; runId?: string; metadata?: unknown }): Promise<void>;
}

export interface ProcessAgentJobOptions {
  repos: WorkerRepositories;
  executor: Executor;
  publisher: Publisher;
  larkUpdater?: LarkStatusUpdater;
  policyConfig: WorkerPolicyConfig;
  workspaceRoot?: string;
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
  infra: "일시적 인프라 오류일 수 있습니다. 관리자 콘솔에서 재시도하세요."
};

function failureDetails(category: FailureCategory, nextAction = NEXT_ACTION[category]): {
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

export async function processAgentJob(payload: AgentJobPayload, options: ProcessAgentJobOptions): Promise<ProcessAgentJobResult> {
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

  const run = await options.repos.createRun({
    id: runId,
    jobId: job.jobId,
    attempt,
    workspacePath,
    workBranch
  });

  let progressSequence = 0;
  const appendEvent = (phase: InternalPhase, eventType: string, message: string, metadata?: unknown, source = "worker") =>
    options.repos.appendEvent({
      jobId: job.jobId,
      runId: run.runId,
      attempt: run.attempt,
      phase,
      eventType,
      source,
      message,
      metadata
    });
  const appendProgressLog = (phase: InternalPhase, source: string, message: string) =>
    options.repos.appendLog({
      jobId: job.jobId,
      runId: run.runId,
      source,
      stream: "progress",
      sequence: progressSequence++,
      text: `[${phaseLabel(phase)}] ${message}`
    });
  const transitionJob = async (
    phase: InternalPhase,
    outcome: UserOutcome,
    reason?: string,
    lark?: { status: string; prUrl?: string; prNumber?: number; failureReason?: string },
    failure?: { category: FailureCategory; nextAction: string }
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
      expectedTargetBranch: job.targetBranch
    });
    if (!preExecutionGate.allowed) {
      await options.repos.saveArtifact({
        id: artifactId("policy-gate-pre-execution"),
        jobId: job.jobId,
        runId: run.runId,
        kind: "policy-gate",
        content: preExecutionGate.artifact
      });
      await transitionJob("Failed", "FailedActionable", preExecutionGate.reason, {
        status: "FailedActionable",
        failureReason: preExecutionGate.reason
      }, failureDetails("policy"));
      await appendEvent("Failed", "policy.blocked", preExecutionGate.reason ?? "Pre-execution policy gate blocked job", preExecutionGate.artifact);
      return { status: "policy_blocked", runId: run.runId };
    }

    await transitionJob("Planning", deriveOutcome("Planning"), undefined, { status: "Running" });
    await appendEvent("Planning", "worker.started", "Worker picked up job");
    await appendProgressLog("Planning", "worker", "작업자가 티켓과 저장소 정책을 확인하고 있습니다.");

    await transitionJob("Implementing", deriveOutcome("Implementing"));
    await appendEvent("Implementing", "runner.started", "AI runner started", undefined, "gstack");
    await appendProgressLog("Implementing", "gstack", "실행 워크스페이스를 준비하고 AI runner를 시작합니다.");
    const rawResult = await options.executor({
      job,
      run,
      appendLog: (log) => options.repos.appendLog({ jobId: job.jobId, runId: run.runId, ...log })
    });
    const result = parseAgentResult(rawResult);
    await appendProgressLog("Implementing", "gstack", "AI runner 결과를 수집하고 있습니다.");
    await options.repos.saveArtifact({
      id: artifactId("agent-result"),
      jobId: job.jobId,
      runId: run.runId,
      kind: "agent-result",
      content: result
    });

    if (await isCancelRequested(options.repos, job.jobId)) {
      await transitionJob("Cancelled", "Cancelled", undefined, { status: "Cancelled" });
      await appendEvent("Cancelled", "worker.cancelled", "Worker stopped before policy check");
      return { status: "cancelled", runId: run.runId };
    }

    if (result.status !== "completed") {
      const reason = result.failure?.message ?? `Agent result status: ${result.status}`;
      const outcome = result.retryable ? "FailedInternal" : "FailedActionable";
      await transitionJob("Failed", outcome, reason, { status: outcome, failureReason: reason },
        failureDetails("agent", result.retryable ? NEXT_ACTION.infra : NEXT_ACTION.agent));
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
      expectedTargetBranch: job.targetBranch
    });
    await options.repos.saveArtifact({
      id: artifactId("policy-gate"),
      jobId: job.jobId,
      runId: run.runId,
      kind: "policy-gate",
      content: gate.artifact
    });
    if (!gate.allowed) {
      await transitionJob("Failed", "FailedActionable", gate.reason, { status: "FailedActionable", failureReason: gate.reason }, failureDetails("policy"));
      await appendEvent("Failed", "policy.blocked", gate.reason ?? "Policy gate blocked result", gate.artifact);
      return { status: "policy_blocked", runId: run.runId };
    }

    if (await isCancelRequested(options.repos, job.jobId)) {
      await transitionJob("Cancelled", "Cancelled", undefined, { status: "Cancelled" });
      await appendEvent("Cancelled", "worker.cancelled", "Worker stopped before publishing");
      return { status: "cancelled", runId: run.runId };
    }

    await transitionJob("Publishing", deriveOutcome("Publishing"));
    await appendEvent("Publishing", "publisher.started", "Publisher started", undefined, "publisher");
    await appendProgressLog("Publishing", "publisher", "브랜치를 푸시하고 PR을 생성하고 있습니다.");
    const published = await options.publisher(await createPublishInput(job, run, result));
    await options.repos.savePullRequest({
      id: pullRequestId(),
      jobId: job.jobId,
      runId: run.runId,
      ...published
    });
    await options.repos.appendAuditEvent({
      actor: "worker",
      action: "pull_request.created",
      jobId: job.jobId,
      runId: run.runId,
      metadata: { prUrl: published.prUrl, prNumber: published.prNumber }
    });
    await transitionJob("Completed", deriveOutcome("Completed"), undefined, {
      status: "NeedsReview",
      prUrl: published.prUrl,
      prNumber: published.prNumber
    });
    await appendEvent("Completed", "worker.completed", "Worker completed job", { prUrl: published.prUrl });
    await appendProgressLog("Completed", "worker", "PR 생성이 끝났습니다.");
    return { status: "completed", runId: run.runId };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown worker error";
    await transitionJob("Failed", "FailedInternal", message, { status: "FailedInternal", failureReason: message }, failureDetails("infra"));
    await appendEvent("Failed", "worker.error", message);
    return { status: "failed", runId: run.runId };
  }
}

async function syncLarkStatus(
  larkUpdater: LarkStatusUpdater | undefined,
  job: WorkerJobRecord,
  update: { status: string; prUrl?: string; prNumber?: number; failureReason?: string }
): Promise<void> {
  if (!larkUpdater) return;
  try {
    await larkUpdater({
      recordId: job.larkRecordId,
      status: update.status,
      jobId: job.jobId,
      prUrl: update.prUrl,
      prNumber: update.prNumber,
      failureReason: update.failureReason
    });
  } catch {
    // Lark write-back must not fail the platform-owned job execution.
  }
}

async function isCancelRequested(repos: Pick<WorkerRepositories, "getJobForWorker">, jobId: string): Promise<boolean> {
  const latest = await repos.getJobForWorker(jobId);
  return latest?.phase === "CancelRequested" || latest?.phase === "Cancelling";
}

async function createPublishInput(job: WorkerJobRecord, run: WorkerRunRecord, result: AgentResult): Promise<PublishInput> {
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

  const body = await readPullRequestDraftBody(run.workspacePath, result.pullRequestDraft.bodyPath);

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
    body
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
