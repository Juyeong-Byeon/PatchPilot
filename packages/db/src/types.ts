import type { InternalPhase, Priority, UserOutcome } from "@ticket-to-pr/core";

export interface CreateJobResult {
  jobId: string;
  ticketSnapshotId: string;
  created: boolean;
}

export interface AppendEventInput {
  jobId: string;
  runId?: string;
  attempt?: number;
  phase: string;
  eventType: string;
  source: string;
  message: string;
  metadata?: unknown;
}

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

export interface CreateRunInput {
  id: string;
  jobId: string;
  attempt: number;
  containerId?: string | null;
  runnerImageDigest?: string | null;
  workspacePath?: string | null;
  baseSha?: string | null;
  workBranch?: string | null;
}

export interface RunRecord {
  runId: string;
  jobId: string;
  attempt: number;
  containerId: string | null;
  runnerImageDigest: string | null;
  workspacePath: string;
  baseSha: string | null;
  workBranch: string;
  headSha: string | null;
  exitCode: number | null;
}

export interface AppendLogInput {
  jobId: string;
  runId?: string;
  source: string;
  stream: string;
  sequence: number;
  redactionApplied?: boolean;
  text: string;
}

export interface SaveArtifactInput {
  id: string;
  jobId: string;
  runId?: string;
  kind: string;
  path?: string | null;
  content?: unknown;
}

export interface SavePullRequestInput {
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
}

export interface AppendAuditEventInput {
  actor: string;
  action: string;
  jobId?: string;
  runId?: string;
  metadata?: unknown;
}

export interface MarkPullRequestMergedInput {
  repository: string;
  prNumber: number;
  prUrl?: string;
  mergedAt?: string | null;
}

export type MarkPullRequestMergedResult =
  | {
      status: "updated";
      jobId: string;
      runId: string;
      larkRecordId: string;
      prUrl: string;
      prNumber: number;
    }
  | { status: "not_found" };

export interface RetryPreflight {
  jobId: string;
  phase: string;
  outcome: string;
  lastAttempt: number | null;
  retryable: boolean;
}

export type CancelRequestResult =
  | { status: "requested" }
  | { status: "not_found" }
  | { status: "not_cancelable"; phase: InternalPhase };
