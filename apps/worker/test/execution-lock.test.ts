import { describe, expect, it, vi } from "vitest";
import { acquireJobExecutionLock } from "../src/execution-lock.js";
import type { PgPool } from "@ticket-to-pr/db";

function fakePool(opts: { locked?: boolean; connectError?: Error; queryError?: Error }): {
  pool: PgPool;
  release: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn();
  const query = vi.fn().mockImplementation(async (sql: string) => {
    if (opts.queryError) throw opts.queryError;
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: opts.locked ?? true }] };
    return { rows: [] };
  });
  const client = { query, release };
  const connect = opts.connectError ? vi.fn().mockRejectedValue(opts.connectError) : vi.fn().mockResolvedValue(client);
  return { pool: { connect } as unknown as PgPool, release, query };
}

describe("acquireJobExecutionLock", () => {
  it("acquires the lock and releases it (unlock + client release) on release()", async () => {
    const { pool, release, query } = fakePool({ locked: true });
    const lock = await acquireJobExecutionLock(pool, "job_1");

    expect(lock.acquired).toBe(true);
    expect(query).toHaveBeenCalledWith("select pg_try_advisory_lock(hashtext($1)) as locked", ["job_1"]);

    await lock.release();
    expect(query).toHaveBeenCalledWith("select pg_advisory_unlock(hashtext($1))", ["job_1"]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("reports not-acquired and releases the client when the lock is already held", async () => {
    const { pool, release } = fakePool({ locked: false });
    const lock = await acquireJobExecutionLock(pool, "job_1");

    expect(lock.acquired).toBe(false);
    // The client is returned to the pool immediately; no lock to hold.
    expect(release).toHaveBeenCalledTimes(1);
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it("fails open (acquired:true, no pool work) when no pool is provided", async () => {
    const lock = await acquireJobExecutionLock(undefined, "job_1");
    expect(lock.acquired).toBe(true);
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it("fails open and reports the error when connecting fails", async () => {
    const onError = vi.fn();
    const { pool } = fakePool({ connectError: new Error("pool exhausted") });
    const lock = await acquireJobExecutionLock(pool, "job_1", onError);
    expect(lock.acquired).toBe(true);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("fails open and releases the client when the lock query errors", async () => {
    const onError = vi.fn();
    const { pool, release } = fakePool({ queryError: new Error("query boom") });
    const lock = await acquireJobExecutionLock(pool, "job_1", onError);
    expect(lock.acquired).toBe(true);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(release).toHaveBeenCalledTimes(1);
  });
});
