import { Queue } from "bullmq";
import type { AgentJobPayload } from "./jobs.js";
import { AGENT_JOB_QUEUE } from "./jobs.js";
import { buildDefaultJobOptions, type QueueReliabilityConfig } from "./options.js";

/**
 * Create the agent-job queue with X6 reliability defaults (bounded retries +
 * exponential backoff + capped completed/failed retention). Pass a `config` to
 * override the env-derived defaults (used in tests).
 */
export function createAgentQueue(redisUrl: string, config?: QueueReliabilityConfig): Queue<AgentJobPayload> {
  return new Queue<AgentJobPayload>(AGENT_JOB_QUEUE, {
    connection: { url: redisUrl },
    defaultJobOptions: buildDefaultJobOptions(config),
  });
}

/**
 * Enqueue an agent job. The BullMQ `jobId` is keyed on the platform job id so a
 * duplicate enqueue (e.g. a webhook retry) for the same job is deduplicated by
 * BullMQ before it ever reaches a worker.
 *
 * NOTE (cross-track): the enqueue call sites live in the api track, which owns
 * when/where jobs are added. This helper exists so that track can adopt jobId
 * dedup without re-deriving the key; the queue package does not itself enqueue.
 * Until the api track wires this in, redelivery is still made safe at execution
 * time by the worker's advisory-lock dedup (X6 part 2).
 */
export async function enqueueAgentJob(queue: Queue<AgentJobPayload>, payload: AgentJobPayload): Promise<void> {
  await queue.add(AGENT_JOB_QUEUE, payload, { jobId: agentJobDedupId(payload) });
}

/** Deterministic BullMQ jobId for enqueue-time dedup, keyed on the platform job + attempt. */
export function agentJobDedupId(payload: AgentJobPayload): string {
  return payload.attempt && payload.attempt > 1 ? `${payload.jobId}:attempt-${payload.attempt}` : payload.jobId;
}
