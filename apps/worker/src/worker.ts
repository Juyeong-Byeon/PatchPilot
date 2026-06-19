import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createArtifactId, createPrefixedId, createRunId, deriveOutcome, parseAgentResult } from "@ticket-to-pr/core";
import type { AgentResult, InternalPhase, Priority, UserOutcome } from "@ticket-to-pr/core";
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
  stream: "stdout" | "stderr";
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
  policyConfig: WorkerPolicyConfig;
  workspaceRoot?: string;
  ids?: {
    runId?: () => string;
    artifactId?: (kind: string) => string;
    pullRequestId?: () => string;
  };
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
  const workBranch = `ticket-to-pr/${job.jobId}`;
  const workspacePath = join(options.workspaceRoot ?? "/tmp/ticket-to-pr-worker", job.jobId, runId);
  await mkdir(workspacePath, { recursive: true });

  const run = await options.repos.createRun({
    id: runId,
    jobId: job.jobId,
    attempt,
    workspacePath,
    workBranch
  });

  const appendEvent = (phase: InternalPhase, eventType: string, message: string, metadata?: unknown) =>
    options.repos.appendEvent({
      jobId: job.jobId,
      runId: run.runId,
      attempt: run.attempt,
      phase,
      eventType,
      source: "worker",
      message,
      metadata
    });

  try {
    if (await isCancelRequested(options.repos, job.jobId)) {
      await options.repos.transitionJob(job.jobId, "Cancelled", "Cancelled");
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
      await options.repos.transitionJob(job.jobId, "Failed", "FailedActionable", preExecutionGate.reason);
      await appendEvent("Failed", "policy.blocked", preExecutionGate.reason ?? "Pre-execution policy gate blocked job", preExecutionGate.artifact);
      return { status: "policy_blocked", runId: run.runId };
    }

    await options.repos.transitionJob(job.jobId, "Planning", deriveOutcome("Planning"));
    await appendEvent("Planning", "worker.started", "Worker picked up job");

    await options.repos.transitionJob(job.jobId, "Implementing", deriveOutcome("Implementing"));
    const rawResult = await options.executor({
      job,
      run,
      appendLog: (log) => options.repos.appendLog({ jobId: job.jobId, runId: run.runId, ...log })
    });
    const result = parseAgentResult(rawResult);
    await options.repos.saveArtifact({
      id: artifactId("agent-result"),
      jobId: job.jobId,
      runId: run.runId,
      kind: "agent-result",
      content: result
    });

    if (await isCancelRequested(options.repos, job.jobId)) {
      await options.repos.transitionJob(job.jobId, "Cancelled", "Cancelled");
      await appendEvent("Cancelled", "worker.cancelled", "Worker stopped before policy check");
      return { status: "cancelled", runId: run.runId };
    }

    if (result.status !== "completed") {
      const reason = result.failure?.message ?? `Agent result status: ${result.status}`;
      await options.repos.transitionJob(job.jobId, "Failed", result.retryable ? "FailedInternal" : "FailedActionable", reason);
      await appendEvent("Failed", "worker.failed", reason, result.failure);
      return { status: "failed", runId: run.runId };
    }

    await options.repos.transitionJob(job.jobId, "PolicyChecking", deriveOutcome("PolicyChecking"));
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
      await options.repos.transitionJob(job.jobId, "Failed", "FailedActionable", gate.reason);
      await appendEvent("Failed", "policy.blocked", gate.reason ?? "Policy gate blocked result", gate.artifact);
      return { status: "policy_blocked", runId: run.runId };
    }

    if (await isCancelRequested(options.repos, job.jobId)) {
      await options.repos.transitionJob(job.jobId, "Cancelled", "Cancelled");
      await appendEvent("Cancelled", "worker.cancelled", "Worker stopped before publishing");
      return { status: "cancelled", runId: run.runId };
    }

    await options.repos.transitionJob(job.jobId, "Publishing", deriveOutcome("Publishing"));
    const published = await options.publisher(createPublishInput(job, run, result));
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
    await options.repos.transitionJob(job.jobId, "Completed", deriveOutcome("Completed"));
    await appendEvent("Completed", "worker.completed", "Worker completed job", { prUrl: published.prUrl });
    return { status: "completed", runId: run.runId };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown worker error";
    await options.repos.transitionJob(job.jobId, "Failed", "FailedInternal", message);
    await appendEvent("Failed", "worker.error", message);
    return { status: "failed", runId: run.runId };
  }
}

async function isCancelRequested(repos: Pick<WorkerRepositories, "getJobForWorker">, jobId: string): Promise<boolean> {
  const latest = await repos.getJobForWorker(jobId);
  return latest?.phase === "CancelRequested" || latest?.phase === "Cancelling";
}

function createPublishInput(job: WorkerJobRecord, run: WorkerRunRecord, result: AgentResult): PublishInput {
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
    body: createPullRequestBody(result)
  };
}

function createPullRequestBody(result: AgentResult): string {
  const testLines = result.tests.map((test) => `- ${test.status}: ${test.command} - ${test.summary}`);
  const fileLines = result.changedFiles.map((file) => `- ${file}`);
  const review = result.review?.summary ?? "No review summary provided.";

  return [`## Summary`, review, ``, `## Changed Files`, ...fileLines, ``, `## Tests`, ...testLines].join("\n");
}
