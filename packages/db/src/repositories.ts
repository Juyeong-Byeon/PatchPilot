import { createRunId, type InternalPhase, type TicketSnapshotInput, type UserOutcome } from "@ticket-to-pr/core";
import type { PgPool } from "./client.js";
import type {
  AppendAuditEventInput,
  AppendEventInput,
  AppendLogInput,
  CreateJobResult,
  CreateRunInput,
  RetryPreflight,
  RunRecord,
  SaveArtifactInput,
  SavePullRequestInput,
  WorkerJobRecord
} from "./types.js";

export type { AppendEventInput, CreateJobResult } from "./types.js";

export class Repositories {
  constructor(private readonly pool: PgPool) {}

  async createJobFromTicket(
    input: TicketSnapshotInput,
    ids: { ticketSnapshotId: string; jobId: string }
  ): Promise<CreateJobResult> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const ticketInsert = await client.query<{ id: string }>(
        `insert into ticket_snapshots
         (id, lark_record_id, trigger_version, title, description, definition_of_done, repository, target_branch, priority, raw_fields)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (lark_record_id, trigger_version) do nothing
         returning id`,
        [
          ids.ticketSnapshotId,
          input.larkRecordId,
          input.triggerVersion,
          input.title,
          input.description,
          input.definitionOfDone,
          input.repository,
          input.targetBranch,
          input.priority,
          JSON.stringify(input.rawFields)
        ]
      );
      const ticketSnapshotId =
        ticketInsert.rows[0]?.id ??
        (
          await client.query<{ id: string }>(
            `select id from ticket_snapshots where lark_record_id=$1 and trigger_version=$2`,
            [input.larkRecordId, input.triggerVersion]
          )
        ).rows[0]?.id;
      if (!ticketSnapshotId) throw new Error("Unable to resolve ticket snapshot id");
      const result = await client.query(
        `insert into jobs
         (id, ticket_snapshot_id, lark_record_id, trigger_version, idempotency_key, outcome, phase, priority)
         values ($1,$2,$3,$4,$5,'Queued','Queued',$6)
         on conflict (lark_record_id, trigger_version) do nothing
         returning id`,
        [
          ids.jobId,
          ticketSnapshotId,
          input.larkRecordId,
          input.triggerVersion,
          `${input.larkRecordId}:${input.triggerVersion}`,
          input.priority
        ]
      );
      await client.query("commit");
      return { jobId: ids.jobId, ticketSnapshotId, created: result.rowCount === 1 };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async transitionJob(jobId: string, phase: InternalPhase, outcome: UserOutcome, reason?: string): Promise<void> {
    await this.pool.query(
      `update jobs set phase=$2, outcome=$3, failure_reason=$4, updated_at=now() where id=$1`,
      [jobId, phase, outcome, reason ?? null]
    );
  }

  async appendEvent(input: AppendEventInput): Promise<void> {
    await this.pool.query(
      `insert into run_events(job_id, run_id, attempt, phase, event_type, source, message, metadata)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        input.jobId,
        input.runId ?? null,
        input.attempt ?? null,
        input.phase,
        input.eventType,
        input.source,
        input.message,
        JSON.stringify(input.metadata ?? {})
      ]
    );
  }

  async getJobForWorker(jobId: string): Promise<WorkerJobRecord | null> {
    const result = await this.pool.query<{
      job_id: string;
      ticket_snapshot_id: string;
      lark_record_id: string;
      trigger_version: string;
      title: string;
      description: string;
      definition_of_done: string;
      repository: string;
      target_branch: string;
      priority: "Low" | "Normal" | "High";
      phase: InternalPhase;
      outcome: UserOutcome;
      raw_fields: Record<string, unknown>;
    }>(
      `select
         j.id as job_id,
         j.ticket_snapshot_id,
         j.lark_record_id,
         j.trigger_version,
         ts.title,
         ts.description,
         ts.definition_of_done,
         ts.repository,
         ts.target_branch,
         j.priority,
         j.phase,
         j.outcome,
         ts.raw_fields
       from jobs j
       join ticket_snapshots ts on ts.id = j.ticket_snapshot_id
       where j.id = $1`,
      [jobId]
    );
    const row = result.rows[0];
    if (!row) return null;

    return {
      jobId: row.job_id,
      ticketSnapshotId: row.ticket_snapshot_id,
      larkRecordId: row.lark_record_id,
      triggerVersion: row.trigger_version,
      title: row.title,
      description: row.description,
      definitionOfDone: row.definition_of_done,
      repository: row.repository,
      targetBranch: row.target_branch,
      priority: row.priority,
      phase: row.phase,
      outcome: row.outcome,
      rawFields: row.raw_fields
    };
  }

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const result = await this.pool.query<RunRow>(
      `insert into runs
       (id, job_id, attempt, container_id, runner_image_digest, workspace_path, base_sha, work_branch, started_at, heartbeat_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,now(),now())
       on conflict (id) do update set heartbeat_at=now()
       returning id, job_id, attempt, container_id, runner_image_digest, workspace_path, base_sha, work_branch, head_sha, exit_code`,
      [
        input.id,
        input.jobId,
        input.attempt,
        input.containerId ?? null,
        input.runnerImageDigest ?? null,
        input.workspacePath ?? "",
        input.baseSha ?? null,
        input.workBranch ?? ""
      ]
    );
    return mapRun(result.rows[0]);
  }

  async appendLog(input: AppendLogInput): Promise<void> {
    await this.pool.query(
      `insert into job_logs(job_id, run_id, source, stream, sequence, redaction_applied, text)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        input.jobId,
        input.runId ?? null,
        input.source,
        input.stream,
        input.sequence,
        input.redactionApplied ?? false,
        input.text
      ]
    );
  }

  async saveArtifact(input: SaveArtifactInput): Promise<void> {
    await this.pool.query(
      `insert into artifacts(id, job_id, run_id, kind, path, content)
       values ($1,$2,$3,$4,$5,$6)`,
      [
        input.id,
        input.jobId,
        input.runId ?? null,
        input.kind,
        input.path ?? null,
        input.content === undefined ? null : JSON.stringify(input.content)
      ]
    );
  }

  async savePullRequest(input: SavePullRequestInput): Promise<void> {
    await this.pool.query(
      `insert into pull_requests
       (id, job_id, run_id, repository, target_branch, work_branch, base_sha, head_sha, commit_shas, pr_url, pr_number, pr_title, pr_body)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        input.id,
        input.jobId,
        input.runId,
        input.repository,
        input.targetBranch,
        input.workBranch,
        input.baseSha,
        input.headSha,
        JSON.stringify(input.commitShas),
        input.prUrl,
        input.prNumber,
        input.prTitle,
        input.prBody
      ]
    );
  }

  async listJobs(): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `select
         j.id,
         j.outcome,
         j.phase,
         j.priority,
         j.failure_category,
         j.failure_reason,
         j.next_action,
         j.created_at,
         j.updated_at,
         ts.repository,
         ts.target_branch,
         pr.pr_url,
         last_event.message as last_event
       from jobs j
       join ticket_snapshots ts on ts.id = j.ticket_snapshot_id
       left join lateral (
         select pr_url
         from pull_requests
         where job_id = j.id
         order by created_at desc
         limit 1
       ) pr on true
       left join lateral (
         select message
         from run_events
         where job_id = j.id
         order by created_at desc, id desc
         limit 1
       ) last_event on true
       order by j.created_at desc
       limit 100`
    );
    return result.rows;
  }

  async getJob(jobId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `select
         j.*,
         ts.title,
         ts.description,
         ts.definition_of_done,
         ts.repository,
         ts.target_branch,
         ts.raw_fields,
         pr.pr_url,
         pr.pr_number,
         pr.pr_title
       from jobs j
       join ticket_snapshots ts on ts.id = j.ticket_snapshot_id
       left join lateral (
         select pr_url, pr_number, pr_title
         from pull_requests
         where job_id = j.id
         order by created_at desc
         limit 1
       ) pr on true
       where j.id=$1`,
      [jobId]
    );
    return result.rows[0] ?? null;
  }

  async getJobEvents(jobId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `select *
       from run_events
       where job_id=$1
       order by created_at asc, id asc`,
      [jobId]
    );
    return result.rows;
  }

  async getJobLogs(jobId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `select *
       from job_logs
       where job_id=$1
       order by created_at asc, sequence asc, id asc`,
      [jobId]
    );
    return result.rows;
  }

  async getJobArtifacts(jobId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `select *
       from artifacts
       where job_id=$1
       order by created_at asc, kind asc`,
      [jobId]
    );
    return result.rows;
  }

  async requestCancel(jobId: string, actor = "system", reason?: string): Promise<void> {
    const result = await this.pool.query(
      `update jobs
       set phase='CancelRequested', outcome='Running', failure_reason=$2, updated_at=now()
       where id=$1 and phase not in ('Completed', 'Failed', 'Cancelled', 'CancelFailed')
       returning id`,
      [jobId, reason ?? null]
    );
    if (result.rowCount === 1) {
      await this.appendAuditEvent({
        actor,
        action: "job.cancel_requested",
        jobId,
        metadata: { reason: reason ?? null }
      });
    }
  }

  async createRetryAttempt(jobId: string, actor: string): Promise<{ runId: string; attempt: number }>;
  async createRetryAttempt(input: Omit<CreateRunInput, "attempt">): Promise<RunRecord>;
  async createRetryAttempt(
    inputOrJobId: string | Omit<CreateRunInput, "attempt">,
    actor = "system"
  ): Promise<RunRecord | { runId: string; attempt: number }> {
    const input =
      typeof inputOrJobId === "string"
        ? {
            id: createRunId(),
            jobId: inputOrJobId,
            workspacePath: "",
            workBranch: `ticket-to-pr/${inputOrJobId}`
          }
        : inputOrJobId;
    const attemptResult = await this.pool.query<{ attempt: number | null }>(
      `select max(attempt) as attempt from runs where job_id=$1`,
      [input.jobId]
    );
    const attempt = (attemptResult.rows[0]?.attempt ?? 0) + 1;
    const run = await this.createRun({ ...input, attempt });
    if (typeof inputOrJobId === "string") {
      await this.appendAuditEvent({
        actor,
        action: "job.retry_requested",
        jobId: inputOrJobId,
        runId: run.runId,
        metadata: { attempt }
      });
      return { runId: run.runId, attempt: run.attempt };
    }
    return run;
  }

  async appendAuditEvent(input: AppendAuditEventInput): Promise<void> {
    await this.pool.query(
      `insert into audit_events(actor, action, job_id, run_id, metadata)
       values ($1,$2,$3,$4,$5)`,
      [input.actor, input.action, input.jobId ?? null, input.runId ?? null, JSON.stringify(input.metadata ?? {})]
    );
  }

  async getRetryPreflight(jobId: string): Promise<RetryPreflight | null> {
    const result = await this.pool.query<{
      job_id: string;
      phase: string;
      outcome: string;
      last_attempt: number | null;
      retryable: boolean;
    }>(
      `select
         j.id as job_id,
         j.phase,
         j.outcome,
         max(r.attempt) as last_attempt,
         (j.phase = 'Failed' and j.outcome in ('FailedActionable', 'FailedInternal')) as retryable
       from jobs j
       left join runs r on r.job_id = j.id
       where j.id=$1
       group by j.id, j.phase, j.outcome`,
      [jobId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      jobId: row.job_id,
      phase: row.phase,
      outcome: row.outcome,
      lastAttempt: row.last_attempt,
      retryable: row.retryable
    };
  }
}

interface RunRow {
  id: string;
  job_id: string;
  attempt: number;
  container_id: string | null;
  runner_image_digest: string | null;
  workspace_path: string;
  base_sha: string | null;
  work_branch: string;
  head_sha: string | null;
  exit_code: number | null;
}

function mapRun(row: RunRow): RunRecord {
  return {
    runId: row.id,
    jobId: row.job_id,
    attempt: row.attempt,
    containerId: row.container_id,
    runnerImageDigest: row.runner_image_digest,
    workspacePath: row.workspace_path,
    baseSha: row.base_sha,
    workBranch: row.work_branch,
    headSha: row.head_sha,
    exitCode: row.exit_code
  };
}
