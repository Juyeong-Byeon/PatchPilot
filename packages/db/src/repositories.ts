import type { InternalPhase, TicketSnapshotInput, UserOutcome } from "@ticket-to-pr/core";
import type { PgPool } from "./client.js";
import type { AppendEventInput, CreateJobResult } from "./types.js";

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
          input.rawFields
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
        input.metadata ?? {}
      ]
    );
  }
}
