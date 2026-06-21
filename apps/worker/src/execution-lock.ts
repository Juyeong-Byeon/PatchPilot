import type { PgPool } from "@ticket-to-pr/db";

/**
 * Execution dedup (X6). Prevents a redelivered job (worker crash / BullMQ stall
 * recovery) from launching a second runner and a duplicate PR.
 *
 * Mechanism: a Postgres *session-level* advisory lock keyed on the job id. We
 * dedicate one pooled client to the job for the duration of processing and take
 * `pg_try_advisory_lock(hashtext($jobId))` on it. A `true` result means we are the
 * sole live processor; a `false` result means another worker already holds the
 * lock, so this delivery no-ops instead of running a second time. The lock is a
 * session lock (not `pg_advisory_xact_lock`) specifically because processing is
 * long-running and is not wrapped in a single DB transaction — a transaction lock
 * would release the moment the first statement's transaction ended. We release it
 * explicitly in `finally`, and a crashed worker's lock is auto-released by Postgres
 * when its backend connection drops, so a genuinely dead worker frees the job for
 * the stalled-recovery redelivery.
 *
 * `hashtext` maps the job id to the 32-bit key `pg_try_advisory_lock(int4)` wants;
 * collisions are harmless (two different ids would merely serialize, never
 * mis-skip, because we only treat OUR own lock acquisition as the run gate).
 */
export interface JobExecutionLock {
  acquired: boolean;
  release(): Promise<void>;
}

/**
 * Minimal structural view of a pooled client — just the `query`/`release` we use.
 * Avoids depending on `pg`'s overloaded `Pool.connect()` return type (whose
 * callback overload widens to `void`) while keeping the worker free of a direct
 * `pg` dependency.
 */
interface LockClient {
  query<R extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<{ rows: R[] }>;
  release(): void;
}

const NOOP_RELEASE = async (): Promise<void> => undefined;

/**
 * Try to acquire the per-job execution lock. Returns `{ acquired: false }` (with a
 * no-op release) when another worker holds it — the caller should skip processing.
 * On any DB error the lock is treated as unavailable in a *fail-open* way: we log
 * and proceed without a lock rather than wedging the queue, because the BullMQ
 * `jobId` dedup and the worker's own terminal-state checks are a second line of
 * defense. (Mock/test repositories without a pool pass `undefined` and skip dedup.)
 */
export async function acquireJobExecutionLock(
  pool: PgPool | undefined,
  jobId: string,
  onError?: (error: unknown) => void,
): Promise<JobExecutionLock> {
  if (!pool) return { acquired: true, release: NOOP_RELEASE };

  let client: LockClient;
  try {
    client = (await pool.connect()) as unknown as LockClient;
  } catch (error) {
    onError?.(error);
    // Fail open: could not reach the pool to take a lock — proceed unguarded.
    return { acquired: true, release: NOOP_RELEASE };
  }

  try {
    const result = await client.query<{ locked: boolean }>("select pg_try_advisory_lock(hashtext($1)) as locked", [
      jobId,
    ]);
    const acquired = result.rows[0]?.locked === true;
    if (!acquired) {
      client.release();
      return { acquired: false, release: NOOP_RELEASE };
    }
    return {
      acquired: true,
      release: async () => {
        try {
          await client.query<{ pg_advisory_unlock: boolean }>("select pg_advisory_unlock(hashtext($1))", [jobId]);
        } catch (error) {
          onError?.(error);
        } finally {
          client.release();
        }
      },
    };
  } catch (error) {
    onError?.(error);
    client.release();
    // Fail open on a lock-query error.
    return { acquired: true, release: NOOP_RELEASE };
  }
}
