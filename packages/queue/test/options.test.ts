import { describe, expect, it } from "vitest";
import {
  agentJobDedupId,
  buildDefaultJobOptions,
  buildWorkerReliabilityOptions,
  readQueueReliabilityConfig,
} from "../src/index.js";

describe("readQueueReliabilityConfig", () => {
  it("returns safe defaults when no env is set", () => {
    const config = readQueueReliabilityConfig({});
    expect(config).toMatchObject({
      attempts: 3,
      backoffDelayMs: 5_000,
      removeOnCompleteCount: 1_000,
      removeOnFailCount: 5_000,
      concurrency: 1,
      maxStalledCount: 1,
    });
    expect(config.lockDurationMs).toBeGreaterThan(config.stalledIntervalMs);
  });

  it("honors env overrides and ignores invalid / below-minimum values", () => {
    const config = readQueueReliabilityConfig({
      QUEUE_JOB_ATTEMPTS: "5",
      QUEUE_REMOVE_ON_FAIL: "10",
      WORKER_CONCURRENCY: "4",
      WORKER_LOCK_DURATION_MS: "not-a-number",
      WORKER_STALLED_INTERVAL_MS: "0", // below 1000 min → fallback
    });
    expect(config.attempts).toBe(5);
    expect(config.removeOnFailCount).toBe(10);
    expect(config.concurrency).toBe(4);
    expect(config.lockDurationMs).toBe(30 * 60_000); // fallback
    expect(config.stalledIntervalMs).toBe(30_000); // fallback (0 < min)
  });
});

describe("buildDefaultJobOptions", () => {
  it("sets bounded retries with exponential backoff and capped retention", () => {
    const options = buildDefaultJobOptions(readQueueReliabilityConfig({}));
    expect(options.attempts).toBe(3);
    expect(options.backoff).toEqual({ type: "exponential", delay: 5_000 });
    expect(options.removeOnComplete).toEqual({ count: 1_000 });
    expect(options.removeOnFail).toEqual({ count: 5_000 });
  });
});

describe("buildWorkerReliabilityOptions", () => {
  it("exposes concurrency, lock duration, and stalled recovery", () => {
    const options = buildWorkerReliabilityOptions(readQueueReliabilityConfig({}));
    expect(options).toEqual({
      concurrency: 1,
      lockDuration: 30 * 60_000,
      stalledInterval: 30_000,
      maxStalledCount: 1,
    });
  });
});

describe("agentJobDedupId", () => {
  it("keys on the job id for first attempts and disambiguates retries", () => {
    expect(agentJobDedupId({ jobId: "job_1" })).toBe("job_1");
    expect(agentJobDedupId({ jobId: "job_1", attempt: 1 })).toBe("job_1");
    expect(agentJobDedupId({ jobId: "job_1", attempt: 2 })).toBe("job_1:attempt-2");
  });
});
