import { z } from "zod";

/**
 * Runtime schema for `input/context.json`, the platform-written trusted handoff
 * the worker drops into the runner workspace before launching a runner.
 *
 * `context.json` is REQUIRED platform input (unlike the agent's best-effort
 * `failure.json` / `needs-input.json`, which are defensively parsed and may be
 * ignored). A missing/mis-typed required field here means the worker and runner
 * have drifted out of contract — that must fail LOUDLY rather than degrade into a
 * silent `undefined` that corrupts the emitted `result.json`. This schema is the
 * runner-side symmetry of `parseAgentResult` (which validates the runner's
 * output back to the worker).
 *
 * The producer is `apps/worker/src/executor-gstack.ts` (`writeRunnerInputs`).
 * Extra producer-only keys (`larkRecordId`, `retryGuidance`) are passed through
 * rather than rejected so the worker can extend the handoff without breaking
 * older runners, but the fields the runners actually consume are validated
 * strictly.
 */
export const runnerContextSchema = z
  .object({
    jobId: z.string().min(1),
    ticketSnapshotId: z.string().min(1),
    triggerVersion: z.string().min(1),
    runId: z.string().min(1),
    attempt: z.number().int().nonnegative(),
    workBranch: z.string().min(1),
  })
  .passthrough();

export type RunnerContext = z.infer<typeof runnerContextSchema>;

/**
 * Parses and validates `context.json` content. Accepts either the raw JSON
 * string (the common case — caller passes `readFile(...)` output) or an
 * already-parsed value. Throws a clear error when the JSON is malformed or a
 * required field is missing/mis-typed; callers MUST NOT swallow it.
 */
export function parseRunnerContext(raw: string | unknown): RunnerContext {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`context.json is not valid JSON: ${detail}`);
    }
  }
  const result = runnerContextSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`context.json failed validation: ${result.error.message}`);
  }
  return result.data;
}
