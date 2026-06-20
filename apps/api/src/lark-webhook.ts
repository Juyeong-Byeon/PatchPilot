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
  add(name: string, data: AgentJobPayload): Promise<unknown>;
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

  await queue.add(created.jobId, {
    jobId: created.jobId,
    ticketSnapshotId: created.ticketSnapshotId,
    larkRecordId: ticket.larkRecordId,
    triggerVersion: ticket.triggerVersion,
  });
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
