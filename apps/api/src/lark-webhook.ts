import {
  createJobId,
  createTicketSnapshotId,
  createWorkBranchName,
  parseLarkTicket,
  shouldCreateJobFromTicket,
} from "@ticket-to-pr/core";
import type { LarkStatusUpdater } from "@ticket-to-pr/core";
import type { Repositories } from "@ticket-to-pr/db";
import type { AgentJobPayload } from "@ticket-to-pr/queue";

export interface LarkWebhookInput {
  recordId: string;
  triggerVersion: string;
  fields: Record<string, unknown>;
}

export interface AgentQueue {
  /**
   * `opts.jobId` is the BullMQ dedup key (X6): enqueuing the same jobId twice
   * collapses to one queued job, so a redelivered Lark webhook (which already
   * dedups at the DB via `createJobFromTicket`) cannot also double-enqueue.
   * Optional to stay back-compatible with callers/tests that pass no opts.
   */
  add(name: string, data: AgentJobPayload, opts?: { jobId?: string }): Promise<unknown>;
}

export async function handleLarkWebhook(
  input: LarkWebhookInput,
  repos: Pick<Repositories, "createJobFromTicket" | "appendEvent">,
  queue: AgentQueue,
  larkUpdater?: LarkStatusUpdater,
): Promise<{ action: "ignored" | "duplicate" | "enqueued"; jobId?: string }> {
  const ticket = parseLarkTicket(input.recordId, input.triggerVersion, input.fields);
  if (!shouldCreateJobFromTicket(ticket)) return { action: "ignored" };

  const created = await repos.createJobFromTicket(ticket, {
    jobId: createJobId(),
    ticketSnapshotId: createTicketSnapshotId(),
  });

  if (!created.created) return { action: "duplicate" };

  await queue.add(
    created.jobId,
    {
      jobId: created.jobId,
      ticketSnapshotId: created.ticketSnapshotId,
      larkRecordId: ticket.larkRecordId,
      triggerVersion: ticket.triggerVersion,
    },
    // X6: the jobId (unique per created job) dedups duplicate enqueues.
    { jobId: created.jobId },
  );
  await repos.appendEvent({
    jobId: created.jobId,
    phase: "Queued",
    eventType: "job.enqueued",
    source: "api",
    message: `Queued ${createWorkBranchName(ticket.larkRecordId, ticket.title)}`,
  });
  if (larkUpdater) {
    try {
      await larkUpdater({
        recordId: ticket.larkRecordId,
        status: "Queued",
        jobId: created.jobId,
      });
    } catch {
      // Lark write-back must not fail webhook ingestion after the job is queued.
    }
  }

  return { action: "enqueued", jobId: created.jobId };
}
