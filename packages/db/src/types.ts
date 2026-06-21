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
  /** Pipeline that ran this attempt: 'single-pass' | 'staged' (epic D). Persisted to runs.executor_mode. */
  executorMode?: string | null;
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
  executorMode: string | null;
  /** Operator steering note for this attempt (X4); null when none was attached. */
  guidance: string | null;
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
  prUrl?: string | undefined;
  mergedAt?: string | null | undefined;
}

export interface RecordWebhookDeliveryInput {
  /** Provider delivery id, e.g. GitHub's `x-github-delivery` header. */
  deliveryId: string;
  provider: string;
  larkRecordId?: string | null;
  triggerVersion?: string | null;
  payload?: unknown;
}

export interface JobAwaitingMergeReconcile {
  jobId: string;
  repository: string;
  prNumber: number;
  prUrl: string;
}

export interface MarkPullRequestMergedSuccess {
  jobId: string;
  runId: string;
  larkRecordId: string;
  prUrl: string;
  prNumber: number;
}

export type MarkPullRequestMergedResult =
  // The merge moved the job to Completed for the first time.
  | ({ status: "updated" } & MarkPullRequestMergedSuccess)
  // The job was already terminal (Completed/Failed/Cancelled): the merge was a
  // late or duplicate delivery and was intentionally not re-applied.
  | ({ status: "already_terminal" } & MarkPullRequestMergedSuccess)
  | { status: "not_found" };

export interface RetryPreflight {
  jobId: string;
  phase: string;
  outcome: string;
  lastAttempt: number | null;
  retryable: boolean;
}

/**
 * Operator guidance threaded into a retry (X4). Persisted on the new run so the
 * worker/runner can inject it as a steering instruction for the next attempt.
 */
export interface RetryGuidanceInput {
  guidance?: string | null;
}

/**
 * Aggregate operations metrics (X5). One snapshot over jobs/runs/run_events/
 * pull_requests, optionally scoped to the last `periodDays`. Rates are 0–1
 * fractions; `null` durations mean no job reached NeedsReview in the window.
 */
export interface MetricsSummary {
  /** Window the aggregate covers; null `periodDays` means all-time. */
  periodDays: number | null;
  /** Total jobs created in the window. */
  totalJobs: number;
  /** Jobs that reached NeedsReview (worker parked at phase=Completed). */
  needsReviewJobs: number;
  /** needsReviewJobs / totalJobs (0 when no jobs). */
  successRate: number;
  /** Count of failed jobs (outcome FailedActionable/FailedInternal) by category. */
  failureBreakdown: {
    policy: number;
    agent: number;
    publish: number;
    infra: number;
    /** Failed jobs whose failure_category was null/unrecognized. */
    uncategorized: number;
    total: number;
  };
  /** Queued→NeedsReview wall-clock, seconds, over jobs that reached NeedsReview. */
  runtimeSeconds: {
    p50: number | null;
    p95: number | null;
    /** How many jobs had a measurable Queued→NeedsReview duration. */
    sampleSize: number;
  };
  /** Merged PRs / jobs that reached NeedsReview (the real value signal). */
  mergeRate: number;
  mergedJobs: number;
  /** Jobs with >1 run attempt / total jobs. */
  retryRate: number;
  retriedJobs: number;
  /** Distribution of the latest run's executor_mode across jobs. */
  executorModeDistribution: {
    singlePass: number;
    staged: number;
    /** Latest run had no executor_mode recorded (legacy / pre-mode runs). */
    unknown: number;
  };
}

export type CancelRequestResult =
  | { status: "requested" }
  | { status: "not_found" }
  | { status: "not_cancelable"; phase: InternalPhase };

// ---------------------------------------------------------------------------
// Read-model row shapes (admin console reads).
//
// These mirror the raw rows returned by the admin read queries in
// `repositories.ts` — snake_case, exactly as Postgres returns them, so they are
// intentionally NOT the camelCase domain records above. The route handlers pass
// these straight through to JSON, so the shapes double as the API response
// contract.
//
// Column → TS mapping follows node-postgres' DEFAULT type parsers (no custom
// parser is registered in client.ts):
//   text        → string
//   integer     → number
//   bigserial   → string   (int8 is returned as a string to avoid precision loss)
//   boolean     → boolean
//   timestamptz → Date
//   jsonb       → parsed value (object/array)
// Columns sourced from a LEFT JOIN LATERAL (latest PR / latest run / latest
// event) are nullable because the join may match no row.
// ---------------------------------------------------------------------------

/** One `run_events` row (`getJobEvents`, ordered oldest-first). */
export interface RunEventRow {
  /** bigserial → string. */
  id: string;
  job_id: string;
  run_id: string | null;
  attempt: number | null;
  phase: string;
  event_type: string;
  source: string;
  message: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

/** One `job_logs` row (`getJobLogs`, ordered oldest-first). */
export interface JobLogRow {
  /** bigserial → string. */
  id: string;
  job_id: string;
  run_id: string | null;
  source: string;
  stream: string;
  sequence: number;
  redaction_applied: boolean;
  text: string;
  created_at: Date;
}

/** One `artifacts` row (`getJobArtifacts`). */
export interface ArtifactRow {
  id: string;
  job_id: string;
  run_id: string | null;
  kind: string;
  path: string | null;
  /** jsonb payload; null when the artifact carries no inline content. */
  content: unknown;
  created_at: Date;
}

/**
 * One row of the job list (`listJobs`): a job joined to its ticket snapshot plus
 * the latest PR / run / event. The latest-* columns are nullable (LEFT JOIN
 * LATERAL may match nothing), as are `work_branch` / `executor_mode` which are
 * themselves nullable on `runs`.
 */
export interface JobListRow {
  id: string;
  outcome: UserOutcome;
  phase: InternalPhase;
  priority: Priority;
  failure_category: string | null;
  failure_reason: string | null;
  next_action: string | null;
  created_at: Date;
  updated_at: Date;
  repository: string;
  target_branch: string;
  pr_url: string | null;
  work_branch: string | null;
  attempt: number | null;
  executor_mode: string | null;
  last_event: string | null;
}

/**
 * One job detail row (`getJob`): every `jobs` column (`j.*`) joined to its ticket
 * snapshot (inner join → always present) plus the latest PR / run (LEFT JOIN
 * LATERAL → nullable). Mirrors the `jobs` table — keep in sync if a migration
 * adds/removes a column.
 */
export interface JobDetailRow {
  // jobs (j.*)
  id: string;
  ticket_snapshot_id: string;
  lark_record_id: string;
  trigger_version: string;
  idempotency_key: string;
  outcome: UserOutcome;
  phase: InternalPhase;
  priority: Priority;
  failure_category: string | null;
  failure_reason: string | null;
  next_action: string | null;
  pending_question: string | null;
  created_at: Date;
  updated_at: Date;
  // ticket_snapshots (inner join)
  title: string;
  description: string;
  definition_of_done: string;
  repository: string;
  target_branch: string;
  raw_fields: Record<string, unknown>;
  // latest pull_request (left join lateral)
  pr_url: string | null;
  pr_number: number | null;
  pr_title: string | null;
  // latest run (left join lateral)
  work_branch: string | null;
  attempt: number | null;
  executor_mode: string | null;
}
