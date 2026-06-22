import {
  createJobId,
  createTicketSnapshotId,
  createWorkBranchName,
  isInvalidLarkTicketError,
  parseLarkTicket,
  shouldCreateJobFromTicket,
} from "@ticket-to-pr/core";
import type { LarkStatusUpdater } from "@ticket-to-pr/core";
import type { Repositories } from "@ticket-to-pr/db";
import type { AgentJobPayload } from "@ticket-to-pr/queue";
import { z } from "zod";

/**
 * Runtime shape check for the Lark automation webhook body. Defense in depth ON
 * TOP of the HMAC/timestamp/nonce verification in `createLarkWebhookVerifier` —
 * the verifier proves the bytes are authentic; this proves the three fields the
 * handler reads are present and typed. Unlike GitHub these fields are required,
 * so a body missing them is rejected at the boundary rather than fed to
 * `parseLarkTicket`. `.passthrough()` keeps any extra keys Lark may send.
 */
export const larkWebhookInputSchema = z
  .object({
    recordId: z.string(),
    triggerVersion: z.string(),
    fields: z.record(z.unknown()),
  })
  .passthrough();

export type LarkWebhookInput = z.infer<typeof larkWebhookInputSchema>;

/**
 * Parse an untrusted webhook body into `LarkWebhookInput`. Returns `null` when
 * the body does not match the schema; the route maps that to a 400 so a
 * malformed body never reaches `parseLarkTicket` or crashes the route.
 */
export function parseLarkWebhookInput(body: unknown): LarkWebhookInput | null {
  const result = larkWebhookInputSchema.safeParse(body);
  return result.success ? result.data : null;
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
): Promise<{ action: "invalid" | "ignored" | "duplicate" | "enqueued"; jobId?: string }> {
  let ticket;
  try {
    ticket = parseLarkTicket(input.recordId, input.triggerVersion, input.fields);
  } catch (error) {
    if (isInvalidLarkTicketError(error)) return { action: "invalid" };
    throw error;
  }
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
