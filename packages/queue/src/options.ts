import type { DefaultJobOptions, WorkerOptions } from "bullmq";

/**
 * BullMQ reliability defaults (X6). Centralized so the enqueue side (`Queue`) and
 * the consume side (`Worker`) agree on attempts/backoff/retention and lock/stall
 * behavior. All values are overridable from the environment so operators can tune
 * them without a redeploy.
 */
export interface QueueReliabilityConfig {
  /** Total attempts including the first try (1 = no retry). */
  attempts: number;
  /** Base backoff delay in ms; BullMQ scales it exponentially per attempt. */
  backoffDelayMs: number;
  /** Keep this many completed jobs before trimming (0 = remove immediately). */
  removeOnCompleteCount: number;
  /** Keep this many failed jobs for inspection before trimming. */
  removeOnFailCount: number;
  /** How many jobs a single worker processes in parallel. */
  concurrency: number;
  /**
   * How long (ms) a job's lock is held before BullMQ considers it stalled. Must
   * comfortably exceed a normal heartbeat interval so a busy-but-alive worker is
   * never reaped. The agent run itself is long, so this is generous.
   */
  lockDurationMs: number;
  /** How often (ms) the worker renews its lock / scans for stalled jobs. */
  stalledIntervalMs: number;
  /**
   * How many times a stalled job is re-queued before being moved to failed.
   * Kept low because execution dedup (advisory lock) makes a redelivery a no-op,
   * but a genuinely dead worker still needs its job recovered at least once.
   */
  maxStalledCount: number;
}

const DEFAULTS: QueueReliabilityConfig = {
  attempts: 3,
  backoffDelayMs: 5_000,
  removeOnCompleteCount: 1_000,
  removeOnFailCount: 5_000,
  concurrency: 1,
  // 30 min: an agent run can be long; the worker renews the lock via stalledInterval
  // while alive, so this only bites when the process is actually dead.
  lockDurationMs: 30 * 60_000,
  stalledIntervalMs: 30_000,
  maxStalledCount: 1,
};

function readInt(value: string | undefined, fallback: number, { min = 0 }: { min?: number } = {}): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
}

export function readQueueReliabilityConfig(source: NodeJS.ProcessEnv = process.env): QueueReliabilityConfig {
  return {
    attempts: readInt(source.QUEUE_JOB_ATTEMPTS, DEFAULTS.attempts, { min: 1 }),
    backoffDelayMs: readInt(source.QUEUE_BACKOFF_DELAY_MS, DEFAULTS.backoffDelayMs, { min: 0 }),
    removeOnCompleteCount: readInt(source.QUEUE_REMOVE_ON_COMPLETE, DEFAULTS.removeOnCompleteCount, { min: 0 }),
    removeOnFailCount: readInt(source.QUEUE_REMOVE_ON_FAIL, DEFAULTS.removeOnFailCount, { min: 0 }),
    concurrency: readInt(source.WORKER_CONCURRENCY, DEFAULTS.concurrency, { min: 1 }),
    lockDurationMs: readInt(source.WORKER_LOCK_DURATION_MS, DEFAULTS.lockDurationMs, { min: 1_000 }),
    stalledIntervalMs: readInt(source.WORKER_STALLED_INTERVAL_MS, DEFAULTS.stalledIntervalMs, { min: 1_000 }),
    maxStalledCount: readInt(source.WORKER_MAX_STALLED_COUNT, DEFAULTS.maxStalledCount, { min: 0 }),
  };
}

/**
 * Enqueue-side defaults applied to every job added to the queue: bounded retries
 * with exponential backoff and capped retention so completed/failed jobs do not
 * accumulate unbounded in Redis.
 */
export function buildDefaultJobOptions(
  config: QueueReliabilityConfig = readQueueReliabilityConfig(),
): DefaultJobOptions {
  return {
    attempts: config.attempts,
    backoff: { type: "exponential", delay: config.backoffDelayMs },
    removeOnComplete: { count: config.removeOnCompleteCount },
    removeOnFail: { count: config.removeOnFailCount },
  };
}

/**
 * Consume-side reliability options for the BullMQ `Worker`: explicit concurrency,
 * a generous lock duration, and stalled-job recovery. The `connection` is supplied
 * separately by the caller.
 */
export function buildWorkerReliabilityOptions(
  config: QueueReliabilityConfig = readQueueReliabilityConfig(),
): Pick<WorkerOptions, "concurrency" | "lockDuration" | "stalledInterval" | "maxStalledCount"> {
  return {
    concurrency: config.concurrency,
    lockDuration: config.lockDurationMs,
    stalledInterval: config.stalledIntervalMs,
    maxStalledCount: config.maxStalledCount,
  };
}
