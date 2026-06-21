import { createRunId, type InternalPhase, type TicketSnapshotInput, type UserOutcome } from "@ticket-to-pr/core";
import type { PgPool } from "./client.js";
import { phasesAllowedToTransitionTo, TERMINAL_PHASES } from "./transition-guard.js";
import type {
  AppendAuditEventInput,
  AppendEventInput,
  CancelRequestResult,
  AppendLogInput,
  CreateJobResult,
  CreateRunInput,
  JobAwaitingMergeReconcile,
  MarkPullRequestMergedInput,
  MarkPullRequestMergedResult,
  MetricsSummary,
  RecordWebhookDeliveryInput,
  RetryGuidanceInput,
  RetryPreflight,
  RunRecord,
  SaveArtifactInput,
  SavePullRequestInput,
  WorkerJobRecord,
} from "./types.js";

export type { AppendEventInput, CreateJobResult } from "./types.js";

export class Repositories {
  constructor(private readonly pool: PgPool) {}

  async createJobFromTicket(
    input: TicketSnapshotInput,
    ids: { ticketSnapshotId: string; jobId: string },
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
          JSON.stringify(input.rawFields),
        ],
      );
      const ticketSnapshotId =
        ticketInsert.rows[0]?.id ??
        (
          await client.query<{ id: string }>(
            `select id from ticket_snapshots where lark_record_id=$1 and trigger_version=$2`,
            [input.larkRecordId, input.triggerVersion],
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
          input.priority,
        ],
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

  /**
   * Phase-guarded job transition. Keeps the historical `Promise<void>` contract
   * (worker / admin route consume it as void) while always applying the
   * terminal-state invariant. Use {@link transitionJobGuarded} when the caller
   * needs the no-op signal or wants to assert an `expectedFrom` phase.
   */
  async transitionJob(
    jobId: string,
    phase: InternalPhase,
    outcome: UserOutcome,
    reason?: string,
    failure?: { category?: string | null; nextAction?: string | null },
  ): Promise<void> {
    await this.transitionJobGuarded(jobId, phase, outcome, reason, failure);
  }

  /**
   * Phase-guarded transition that returns whether a row was actually updated:
   * `true` on success, `false` when the guard rejected the write (a no-op — the
   * job already advanced or is terminal). Callers (e.g. a reconcile poller in the
   * worker / T3) can branch on this signal.
   *
   * Two guards compose in the single `update ... where`:
   *  - terminal invariant (always on): a job in `Completed` / `Failed` /
   *    `Cancelled` is immutable; no late event may overwrite it. `CancelFailed`
   *    is intentionally NOT terminal here because core's whitelist still allows
   *    `CancelFailed -> Failed`.
   *  - optimistic `expectedFrom` (opt-in): when supplied, the row must currently
   *    be in one of those phases. Pass
   *    `phasesAllowedToTransitionTo(phase)` to enforce core's `transitionPhase`
   *    whitelist at the DB layer, making the DB the single enforcement point.
   */
  async transitionJobGuarded(
    jobId: string,
    phase: InternalPhase,
    outcome: UserOutcome,
    reason?: string,
    failure?: { category?: string | null; nextAction?: string | null },
    expectedFrom?: InternalPhase | InternalPhase[],
  ): Promise<boolean> {
    const params: unknown[] = [
      jobId,
      phase,
      outcome,
      reason ?? null,
      failure?.category ?? null,
      failure?.nextAction ?? null,
      // $7: truly-terminal phases that may never be transitioned out of.
      TERMINAL_PHASES,
    ];
    let guard = `where id=$1 and phase <> all($7::text[])`;
    if (expectedFrom !== undefined) {
      params.push(Array.isArray(expectedFrom) ? expectedFrom : [expectedFrom]);
      guard += ` and phase = any($${params.length}::text[])`;
    }
    const result = await this.pool.query(
      `update jobs
       set phase=$2, outcome=$3, failure_reason=$4, failure_category=$5, next_action=$6, updated_at=now()
       ${guard}`,
      params,
    );
    return result.rowCount === 1;
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
        JSON.stringify(input.metadata ?? {}),
      ],
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
      [jobId],
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
      rawFields: row.raw_fields,
    };
  }

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const result = await this.pool.query<RunRow>(
      `insert into runs
       (id, job_id, attempt, container_id, runner_image_digest, workspace_path, base_sha, work_branch, executor_mode, started_at, heartbeat_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),now())
       on conflict (id) do update set
         workspace_path = coalesce(nullif(excluded.workspace_path, ''), runs.workspace_path),
         work_branch = coalesce(nullif(excluded.work_branch, ''), runs.work_branch),
         executor_mode = coalesce(excluded.executor_mode, runs.executor_mode),
         heartbeat_at=now()
       returning id, job_id, attempt, container_id, runner_image_digest, workspace_path, base_sha, work_branch, head_sha, exit_code, executor_mode`,
      [
        input.id,
        input.jobId,
        input.attempt,
        input.containerId ?? null,
        input.runnerImageDigest ?? null,
        input.workspacePath ?? "",
        input.baseSha ?? null,
        input.workBranch ?? "",
        input.executorMode ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("insert into runs returned no row");
    return mapRun(row);
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
        input.text,
      ],
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
        input.content === undefined ? null : JSON.stringify(input.content),
      ],
    );
  }

  async savePullRequest(input: SavePullRequestInput): Promise<void> {
    // X2 idempotency: a retried publish that reused an existing open PR (same
    // repository, pr_number) must not throw on the (repository, pr_number) unique
    // index — upsert the latest evidence instead so reconcile/merge still resolve
    // to one row. Keeps the original id stable; refreshes run/sha/body fields.
    await this.pool.query(
      `insert into pull_requests
       (id, job_id, run_id, repository, target_branch, work_branch, base_sha, head_sha, commit_shas, pr_url, pr_number, pr_title, pr_body)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       on conflict (repository, pr_number) do update set
         run_id = excluded.run_id,
         target_branch = excluded.target_branch,
         work_branch = excluded.work_branch,
         base_sha = excluded.base_sha,
         head_sha = excluded.head_sha,
         commit_shas = excluded.commit_shas,
         pr_url = excluded.pr_url,
         pr_title = excluded.pr_title,
         pr_body = excluded.pr_body`,
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
        input.prBody,
      ],
    );
  }

  async markPullRequestMerged(input: MarkPullRequestMergedInput): Promise<MarkPullRequestMergedResult> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query<{
        job_id: string;
        run_id: string;
        lark_record_id: string;
        pr_url: string;
        pr_number: number;
      }>(
        `select pr.job_id, pr.run_id, j.lark_record_id, pr.pr_url, pr.pr_number
         from pull_requests pr
         join jobs j on j.id = pr.job_id
         where pr.repository=$1 and pr.pr_number=$2
         order by pr.created_at desc
         limit 1`,
        [input.repository, input.prNumber],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query("commit");
        return { status: "not_found" };
      }

      // Terminal invariant: only a job that the worker has parked at
      // phase='Completed', outcome='NeedsReview' may be advanced to a merged
      // (outcome='Completed') state. A job that is already merged
      // (outcome='Completed') or settled some other way (Failed / Cancelled /
      // CancelFailed) must not be overwritten by a late or duplicate merge
      // webhook. The guard shares the transaction with the row lookup; a zero-row
      // result means the merge is already-applied / superseded, so we emit no
      // duplicate audit or run event.
      const updated = await client.query(
        `update jobs
         set phase='Completed', outcome='Completed', failure_reason=null, updated_at=now()
         where id=$1
           and outcome <> 'Completed'
           and phase not in ('Failed', 'Cancelled', 'CancelFailed')`,
        [row.job_id],
      );
      if (updated.rowCount !== 1) {
        await client.query("commit");
        return {
          status: "already_terminal",
          jobId: row.job_id,
          runId: row.run_id,
          larkRecordId: row.lark_record_id,
          prUrl: input.prUrl ?? row.pr_url,
          prNumber: row.pr_number,
        };
      }
      await client.query(
        `insert into run_events(job_id, run_id, phase, event_type, source, message, metadata)
         values ($1,$2,'Completed','pull_request.merged','github',$3,$4)`,
        [
          row.job_id,
          row.run_id,
          `Pull request #${row.pr_number} was merged`,
          JSON.stringify({
            prUrl: input.prUrl ?? row.pr_url,
            prNumber: row.pr_number,
            mergedAt: input.mergedAt ?? null,
          }),
        ],
      );
      await client.query(
        `insert into audit_events(actor, action, job_id, run_id, metadata)
         values ('github','pull_request.merged',$1,$2,$3)`,
        [
          row.job_id,
          row.run_id,
          JSON.stringify({
            prUrl: input.prUrl ?? row.pr_url,
            prNumber: row.pr_number,
            mergedAt: input.mergedAt ?? null,
          }),
        ],
      );
      await client.query("commit");
      return {
        status: "updated",
        jobId: row.job_id,
        runId: row.run_id,
        larkRecordId: row.lark_record_id,
        prUrl: input.prUrl ?? row.pr_url,
        prNumber: row.pr_number,
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
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
         last_run.work_branch,
         last_run.attempt,
         last_run.executor_mode,
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
         select work_branch, attempt, executor_mode
         from runs
         where job_id = j.id
         order by attempt desc, started_at desc
         limit 1
       ) last_run on true
       left join lateral (
         select message
         from run_events
         where job_id = j.id
         order by created_at desc, id desc
         limit 1
       ) last_event on true
       order by j.created_at desc
       limit 100`,
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
         pr.pr_title,
         last_run.work_branch,
         last_run.attempt,
         last_run.executor_mode
       from jobs j
       join ticket_snapshots ts on ts.id = j.ticket_snapshot_id
       left join lateral (
         select pr_url, pr_number, pr_title
         from pull_requests
         where job_id = j.id
         order by created_at desc
         limit 1
       ) pr on true
       left join lateral (
         select work_branch, attempt, executor_mode
         from runs
         where job_id = j.id
         order by attempt desc, started_at desc
         limit 1
       ) last_run on true
       where j.id=$1`,
      [jobId],
    );
    return result.rows[0] ?? null;
  }

  async getJobEvents(jobId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `select *
       from run_events
       where job_id=$1
       order by created_at asc, id asc`,
      [jobId],
    );
    return result.rows;
  }

  async getJobLogs(jobId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `select *
       from job_logs
       where job_id=$1
       order by created_at asc, sequence asc, id asc`,
      [jobId],
    );
    return result.rows;
  }

  async getJobArtifacts(jobId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `select *
       from artifacts
       where job_id=$1
       order by created_at asc, kind asc`,
      [jobId],
    );
    return result.rows;
  }

  async requestCancel(jobId: string, actor = "system", reason?: string): Promise<CancelRequestResult> {
    // Phases from which core's whitelist permits `* -> CancelRequested`. This is
    // exactly {Queued, Planning, Implementing, Reviewing, Testing}; Publishing and
    // all terminal/cancel phases are excluded. Deriving from the whitelist keeps
    // the cancel guard in lockstep with the worker state machine.
    const cancelableFrom = phasesAllowedToTransitionTo("CancelRequested");

    // Single atomic guarded update — no read-then-write race window. Either the
    // row is in a cancelable phase and we flip it to CancelRequested, or nothing
    // changes and we report why.
    const result = await this.pool.query(
      `update jobs
       set phase='CancelRequested', outcome='Running', failure_reason=$3, updated_at=now()
       where id=$1 and phase = any($2::text[])
       returning id`,
      [jobId, cancelableFrom, reason ?? null],
    );
    if (result.rowCount === 1) {
      await this.appendAuditEvent({
        actor,
        action: "job.cancel_requested",
        jobId,
        metadata: { reason: reason ?? null },
      });
      return { status: "requested" };
    }

    // The guard rejected the update. Read the current phase to distinguish a
    // missing job from a non-cancelable one (terminal, Publishing, or already
    // cancelling).
    const current = await this.pool.query<{ phase: InternalPhase }>(`select phase from jobs where id=$1`, [jobId]);
    const phase = current.rows[0]?.phase;
    if (!phase) return { status: "not_found" };
    return { status: "not_cancelable", phase };
  }

  async createRetryAttempt(
    jobId: string,
    actor: string,
    guidance?: RetryGuidanceInput,
  ): Promise<{ runId: string; attempt: number }>;
  async createRetryAttempt(input: Omit<CreateRunInput, "attempt">): Promise<RunRecord>;
  async createRetryAttempt(
    inputOrJobId: string | Omit<CreateRunInput, "attempt">,
    actor = "system",
    guidance?: RetryGuidanceInput,
  ): Promise<RunRecord | { runId: string; attempt: number }> {
    if (typeof inputOrJobId === "string") {
      return this.createRetryAttemptForJob(inputOrJobId, actor, guidance);
    }

    const input = inputOrJobId;
    const attemptResult = await this.pool.query<{ attempt: number | null }>(
      `select max(attempt) as attempt from runs where job_id=$1`,
      [input.jobId],
    );
    const attempt = (attemptResult.rows[0]?.attempt ?? 0) + 1;
    const run = await this.createRun({
      ...input,
      attempt,
      workBranch: input.workBranch || createAttemptWorkBranch(input.jobId, attempt),
    });
    return run;
  }

  private async createRetryAttemptForJob(
    jobId: string,
    actor: string,
    guidanceInput?: RetryGuidanceInput,
  ): Promise<{ runId: string; attempt: number }> {
    // Empty/whitespace guidance is treated as none. The route already normalizes,
    // but guard here too so the persisted value is always a non-empty string or null.
    const guidance = guidanceInput?.guidance?.trim() ? guidanceInput.guidance.trim() : null;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const jobResult = await client.query<{ id: string; phase: InternalPhase; outcome: UserOutcome }>(
        `select id, phase, outcome
         from jobs
         where id=$1
         for update`,
        [jobId],
      );
      const job = jobResult.rows[0];
      if (!job) throw createHttpError(404, "Job not found");
      // FailedInternal is always retryable. FailedActionable is only retryable
      // when the operator supplied guidance to steer the next attempt (X4); a
      // bare re-run of an actionable failure would just reproduce it.
      const retryable =
        job.phase === "Failed" &&
        (job.outcome === "FailedInternal" || (job.outcome === "FailedActionable" && guidance !== null));
      if (!retryable) {
        throw createHttpError(409, "Job is not retryable");
      }

      const attemptResult = await client.query<{ attempt: number | null }>(
        `select max(attempt) as attempt from runs where job_id=$1`,
        [jobId],
      );
      const attempt = (attemptResult.rows[0]?.attempt ?? 0) + 1;
      const runId = createRunId();
      const workBranch = createAttemptWorkBranch(jobId, attempt);
      // guidance is persisted on the run so the worker/runner (other tracks) can
      // read it back via getRunGuidance / getJobForWorker and inject it as a
      // steering instruction for this attempt.
      const runResult = await client.query<RunRow>(
        `insert into runs
         (id, job_id, attempt, workspace_path, work_branch, guidance, started_at, heartbeat_at)
         values ($1,$2,$3,$4,$5,$6,now(),now())
         returning id, job_id, attempt, container_id, runner_image_digest, workspace_path, base_sha, work_branch, head_sha, exit_code, guidance`,
        [runId, jobId, attempt, "", workBranch, guidance],
      );
      const runRow = runResult.rows[0];
      if (!runRow) throw new Error("insert into runs returned no row");
      const run = mapRun(runRow);

      await client.query(
        `update jobs
         set phase='Queued', outcome='Queued', failure_reason=null, failure_category=null, next_action=null, updated_at=now()
         where id=$1`,
        [jobId],
      );
      await client.query(
        `insert into audit_events(actor, action, job_id, run_id, metadata)
         values ($1,$2,$3,$4,$5)`,
        // Record whether guidance was attached (but not its full text) for audit.
        [actor, "job.retry_requested", jobId, run.runId, JSON.stringify({ attempt, hasGuidance: guidance !== null })],
      );
      await client.query("commit");
      return { runId: run.runId, attempt: run.attempt };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Park a job on a human question (NeedsInput / 입력 대기). One atomic,
   * phase-guarded write that sets phase='AwaitingInput', outcome='NeedsInput', AND
   * persists the agent's question to jobs.pending_question. The terminal invariant
   * (a Completed/Failed/Cancelled job is immutable) and the optional `expectedFrom`
   * guard compose in the single `update ... where`, so a concurrent cancel or a
   * stale delivery can never clobber a settled job — they no-op (rowCount 0).
   * Returns `true` when the job was parked, `false` when the guard rejected it.
   *
   * Pass `phasesAllowedToTransitionTo('AwaitingInput')` (the running phases) as
   * `expectedFrom` to enforce core's whitelist at the DB layer.
   */
  async parkAwaitingInput(
    jobId: string,
    question: string,
    expectedFrom?: InternalPhase | InternalPhase[],
  ): Promise<boolean> {
    const params: unknown[] = [jobId, question, TERMINAL_PHASES];
    let guard = `where id=$1 and phase <> all($3::text[])`;
    if (expectedFrom !== undefined) {
      params.push(Array.isArray(expectedFrom) ? expectedFrom : [expectedFrom]);
      guard += ` and phase = any($${params.length}::text[])`;
    }
    const result = await this.pool.query(
      `update jobs
       set phase='AwaitingInput', outcome='NeedsInput', pending_question=$2,
           failure_reason=null, failure_category=null, next_action=null, updated_at=now()
       ${guard}`,
      params,
    );
    return result.rowCount === 1;
  }

  /**
   * Resume a parked job by injecting the operator's answer (NeedsInput → Queued).
   * Reuses the retry-with-guidance plumbing exactly: the answer is persisted as the
   * NEW run's `guidance`, so the worker reads it back (resolveRetryGuidance) and
   * seeds the next agent attempt with it — an "answer" IS guidance, just entered
   * from the parked state instead of from Failed.
   *
   * Allowed ONLY when the job is currently parked (outcome='NeedsInput' /
   * phase='AwaitingInput'); any other state throws 409. Clears pending_question,
   * re-queues the job, and writes a `job.answer_submitted` audit row (actor,
   * attempt, hasAnswer:true). The `for update` lock + guarded re-queue make a double
   * submit impossible: the second caller sees a no-longer-parked job and 409s.
   */
  async answerNeedsInput(jobId: string, answer: string, actor: string): Promise<{ runId: string; attempt: number }> {
    const trimmed = answer.trim();
    if (!trimmed) throw createHttpError(409, "Answer must not be empty");
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const jobResult = await client.query<{ id: string; phase: InternalPhase; outcome: UserOutcome }>(
        `select id, phase, outcome
         from jobs
         where id=$1
         for update`,
        [jobId],
      );
      const job = jobResult.rows[0];
      if (!job) throw createHttpError(404, "Job not found");
      // Re-park is impossible: only a job that is actually parked on a question may
      // be answered. A second concurrent submit (or an answer to an already-resumed
      // job) sees outcome<>NeedsInput and is rejected.
      if (job.outcome !== "NeedsInput" || job.phase !== "AwaitingInput") {
        throw createHttpError(409, "Job is not awaiting input");
      }

      const attemptResult = await client.query<{ attempt: number | null }>(
        `select max(attempt) as attempt from runs where job_id=$1`,
        [jobId],
      );
      const attempt = (attemptResult.rows[0]?.attempt ?? 0) + 1;
      const runId = createRunId();
      const workBranch = createAttemptWorkBranch(jobId, attempt);
      // The answer is persisted as the new run's guidance — identical to the
      // retry-with-guidance path — so the worker injects it into this attempt.
      const runResult = await client.query<RunRow>(
        `insert into runs
         (id, job_id, attempt, workspace_path, work_branch, guidance, started_at, heartbeat_at)
         values ($1,$2,$3,$4,$5,$6,now(),now())
         returning id, job_id, attempt, container_id, runner_image_digest, workspace_path, base_sha, work_branch, head_sha, exit_code, guidance`,
        [runId, jobId, attempt, "", workBranch, trimmed],
      );
      const runRow = runResult.rows[0];
      if (!runRow) throw new Error("insert into runs returned no row");
      const run = mapRun(runRow);

      // Resume + clear the pending question. AwaitingInput → Queued is the only
      // forward edge core's whitelist allows for a parked job.
      await client.query(
        `update jobs
         set phase='Queued', outcome='Queued', pending_question=null,
             failure_reason=null, failure_category=null, next_action=null, updated_at=now()
         where id=$1`,
        [jobId],
      );
      await client.query(
        `insert into audit_events(actor, action, job_id, run_id, metadata)
         values ($1,$2,$3,$4,$5)`,
        // Record that an answer was attached (but not its text) for audit.
        [actor, "job.answer_submitted", jobId, run.runId, JSON.stringify({ attempt, hasAnswer: true })],
      );
      await client.query("commit");
      return { runId: run.runId, attempt: run.attempt };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Reads back the operator guidance persisted on a run (X4). The worker/runner
   * (other tracks) call this for the attempt's runId to fetch the steering note
   * and inject it into the next agent invocation. Returns null when no guidance
   * was attached or the run does not exist.
   */
  async getRunGuidance(runId: string): Promise<string | null> {
    const result = await this.pool.query<{ guidance: string | null }>(`select guidance from runs where id=$1`, [runId]);
    return result.rows[0]?.guidance ?? null;
  }

  async appendAuditEvent(input: AppendAuditEventInput): Promise<void> {
    await this.pool.query(
      `insert into audit_events(actor, action, job_id, run_id, metadata)
       values ($1,$2,$3,$4,$5)`,
      [input.actor, input.action, input.jobId ?? null, input.runId ?? null, JSON.stringify(input.metadata ?? {})],
    );
  }

  /**
   * Idempotent dedup of an inbound webhook keyed by its provider delivery id.
   * Returns `true` the first time a delivery id is seen and `false` for every
   * replay, letting callers process a delivery exactly once. The race-free
   * `on conflict do nothing` makes concurrent retries of the same delivery safe.
   */
  async recordWebhookDelivery(input: RecordWebhookDeliveryInput): Promise<boolean> {
    const result = await this.pool.query(
      `insert into webhook_events(id, provider, lark_record_id, trigger_version, payload)
       values ($1,$2,$3,$4,$5)
       on conflict (id) do nothing`,
      [
        input.deliveryId,
        input.provider,
        input.larkRecordId ?? null,
        input.triggerVersion ?? null,
        JSON.stringify(input.payload ?? {}),
      ],
    );
    return result.rowCount === 1;
  }

  /**
   * Jobs that are awaiting a merge webhook that may never have arrived: the
   * worker finished (phase Completed maps to user outcome NeedsReview) and an open
   * PR exists, but no merge has been recorded. A future reconcile poller (worker /
   * T3) can take this list and ask GitHub whether each PR is merged, then call
   * `markPullRequestMerged`. This is the query only — no poller here.
   */
  async listJobsAwaitingMergeReconcile(limit = 100): Promise<JobAwaitingMergeReconcile[]> {
    const result = await this.pool.query<{
      job_id: string;
      repository: string;
      pr_number: number;
      pr_url: string;
    }>(
      `select j.id as job_id, pr.repository, pr.pr_number, pr.pr_url
       from jobs j
       join lateral (
         select repository, pr_number, pr_url
         from pull_requests
         where job_id = j.id
         order by created_at desc
         limit 1
       ) pr on true
       where j.phase = 'Completed' and j.outcome = 'NeedsReview'
       order by j.updated_at asc
       limit $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      jobId: row.job_id,
      repository: row.repository,
      prNumber: row.pr_number,
      prUrl: row.pr_url,
    }));
  }

  /**
   * Aggregate operations metrics (X5) over jobs/runs/run_events/pull_requests.
   * Optionally scoped to jobs created in the last `periodDays` (omit for
   * all-time). Computed entirely in SQL in a single round trip; every rate is a
   * 0–1 fraction and durations are seconds.
   *
   * Runtime is the wall-clock from the job entering Queued (`jobs.created_at`,
   * the row is inserted at phase=Queued) to the run_event that records the job
   * reaching NeedsReview (the worker transition to phase='Completed'), per the
   * §6 "Queued→NeedsReview from event timestamps" definition. p50/p95 use the
   * `percentile_cont` continuous percentile over that sample.
   *
   * Categories mirror the worker's `FailureCategory`
   * (policy|agent|publish|infra); any failed job with a null/unknown
   * `failure_category` rolls into `uncategorized` so the breakdown always sums to
   * the failed-job count.
   */
  async getMetrics(periodDays?: number): Promise<MetricsSummary> {
    // Single window predicate reused across every sub-aggregate. When periodDays
    // is omitted we pass null and the `$1::int is null` short-circuits the filter
    // so the same SQL serves both the scoped and all-time cases.
    const days = periodDays ?? null;
    const result = await this.pool.query<{
      total_jobs: string;
      needs_review_jobs: string;
      merged_jobs: string;
      retried_jobs: string;
      failed_total: string;
      failed_policy: string;
      failed_agent: string;
      failed_publish: string;
      failed_infra: string;
      failed_uncategorized: string;
      mode_single: string;
      mode_staged: string;
      mode_unknown: string;
      runtime_sample: string;
      runtime_p50: string | null;
      runtime_p95: string | null;
    }>(
      `with windowed_jobs as (
         select j.id, j.outcome, j.failure_category, j.created_at
         from jobs j
         where $1::int is null or j.created_at >= now() - make_interval(days => $1::int)
       ),
       -- First run_event that records the job reaching NeedsReview (worker parks
       -- it at phase='Completed'). Earliest such event per job is the endpoint.
       needs_review_at as (
         select e.job_id, min(e.created_at) as reached_at
         from run_events e
         where e.phase = 'Completed'
         group by e.job_id
       ),
       -- Latest run per job carries the executor_mode actually used.
       latest_run as (
         select distinct on (r.job_id) r.job_id, r.executor_mode
         from runs r
         order by r.job_id, r.attempt desc, r.started_at desc
       ),
       -- Jobs with more than one run attempt were retried.
       run_counts as (
         select job_id, count(*) as n from runs group by job_id
       )
       select
         count(*)::text as total_jobs,
         count(*) filter (where wj.outcome in ('NeedsReview', 'Completed'))::text as needs_review_jobs,
         count(*) filter (where wj.outcome = 'Completed')::text as merged_jobs,
         count(*) filter (where coalesce(rc.n, 0) > 1)::text as retried_jobs,
         count(*) filter (where wj.outcome in ('FailedActionable', 'FailedInternal'))::text as failed_total,
         count(*) filter (where wj.outcome in ('FailedActionable', 'FailedInternal') and wj.failure_category = 'policy')::text as failed_policy,
         count(*) filter (where wj.outcome in ('FailedActionable', 'FailedInternal') and wj.failure_category = 'agent')::text as failed_agent,
         count(*) filter (where wj.outcome in ('FailedActionable', 'FailedInternal') and wj.failure_category = 'publish')::text as failed_publish,
         count(*) filter (where wj.outcome in ('FailedActionable', 'FailedInternal') and wj.failure_category = 'infra')::text as failed_infra,
         count(*) filter (where wj.outcome in ('FailedActionable', 'FailedInternal') and (wj.failure_category is null or wj.failure_category not in ('policy', 'agent', 'publish', 'infra')))::text as failed_uncategorized,
         count(*) filter (where lr.executor_mode = 'single-pass')::text as mode_single,
         count(*) filter (where lr.executor_mode = 'staged')::text as mode_staged,
         count(*) filter (where lr.executor_mode is null or lr.executor_mode not in ('single-pass', 'staged'))::text as mode_unknown,
         count(nr.reached_at)::text as runtime_sample,
         (percentile_cont(0.5) within group (order by extract(epoch from (nr.reached_at - wj.created_at)))
           filter (where nr.reached_at is not null))::text as runtime_p50,
         (percentile_cont(0.95) within group (order by extract(epoch from (nr.reached_at - wj.created_at)))
           filter (where nr.reached_at is not null))::text as runtime_p95
       from windowed_jobs wj
       left join needs_review_at nr on nr.job_id = wj.id
       left join latest_run lr on lr.job_id = wj.id
       left join run_counts rc on rc.job_id = wj.id`,
      [days],
    );

    const row = result.rows[0];
    const totalJobs = Number(row?.total_jobs ?? 0);
    const needsReviewJobs = Number(row?.needs_review_jobs ?? 0);
    const mergedJobs = Number(row?.merged_jobs ?? 0);
    const retriedJobs = Number(row?.retried_jobs ?? 0);
    const failureBreakdown = {
      policy: Number(row?.failed_policy ?? 0),
      agent: Number(row?.failed_agent ?? 0),
      publish: Number(row?.failed_publish ?? 0),
      infra: Number(row?.failed_infra ?? 0),
      uncategorized: Number(row?.failed_uncategorized ?? 0),
      total: Number(row?.failed_total ?? 0),
    };
    const safeRate = (numerator: number, denominator: number): number =>
      denominator > 0 ? numerator / denominator : 0;

    return {
      periodDays: periodDays ?? null,
      totalJobs,
      needsReviewJobs,
      successRate: safeRate(needsReviewJobs, totalJobs),
      failureBreakdown,
      runtimeSeconds: {
        p50: row?.runtime_p50 != null ? Number(row.runtime_p50) : null,
        p95: row?.runtime_p95 != null ? Number(row.runtime_p95) : null,
        sampleSize: Number(row?.runtime_sample ?? 0),
      },
      // Merge rate is against NeedsReview-reached jobs: only a parked PR can be
      // merged, so this is the share of review-ready work that actually landed.
      mergeRate: safeRate(mergedJobs, needsReviewJobs),
      mergedJobs,
      retryRate: safeRate(retriedJobs, totalJobs),
      retriedJobs,
      executorModeDistribution: {
        singlePass: Number(row?.mode_single ?? 0),
        staged: Number(row?.mode_staged ?? 0),
        unknown: Number(row?.mode_unknown ?? 0),
      },
    };
  }

  /**
   * Read every persisted setting override as a key→value map. Values are stored as
   * jsonb so they round-trip with their JSON type (number/boolean/string/array). An
   * empty map (no overrides) means behavior is identical to env-only — the worker /
   * api treat a missing key as "fall back to env".
   */
  async getAppSettings(): Promise<Record<string, unknown>> {
    const result = await this.pool.query<{ key: string; value: unknown }>(`select key, value from app_settings`);
    const settings: Record<string, unknown> = {};
    for (const row of result.rows) {
      settings[row.key] = row.value;
    }
    return settings;
  }

  /**
   * Upsert each provided setting override, stamping updated_by/updated_at. Callers
   * (the api) must have already validated the keys (EDITABLE_KEYS) and values
   * (registry) — this method only persists. A single transaction so a multi-key save
   * is all-or-nothing.
   */
  async setAppSettings(updates: Record<string, unknown>, actor: string): Promise<void> {
    const entries = Object.entries(updates);
    if (entries.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      for (const [key, value] of entries) {
        await client.query(
          `insert into app_settings(key, value, updated_by, updated_at)
           values ($1, $2::jsonb, $3, now())
           on conflict (key) do update set
             value = excluded.value,
             updated_by = excluded.updated_by,
             updated_at = now()`,
          [key, JSON.stringify(value), actor],
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
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
         (j.phase = 'Failed' and j.outcome = 'FailedInternal') as retryable
       from jobs j
       left join runs r on r.job_id = j.id
       where j.id=$1
       group by j.id, j.phase, j.outcome`,
      [jobId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      jobId: row.job_id,
      phase: row.phase,
      outcome: row.outcome,
      lastAttempt: row.last_attempt,
      retryable: row.retryable,
    };
  }
}

function createAttemptWorkBranch(jobId: string, attempt: number): string {
  return attempt > 1 ? `ticket-to-pr/${jobId}-attempt-${attempt}` : `ticket-to-pr/${jobId}`;
}

function createHttpError(statusCode: 404 | 409, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
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
  executor_mode?: string | null;
  guidance?: string | null;
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
    exitCode: row.exit_code,
    executorMode: row.executor_mode ?? null,
    guidance: row.guidance ?? null,
  };
}
