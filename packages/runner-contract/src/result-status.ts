import { z } from "zod";

/**
 * Minimal envelope schema for reading just the `status` off a runner `result.json`.
 *
 * Unlike `parseAgentResult` (core) — which fully validates a completed/failed/
 * cancelled agent result — the runner's `main.ts` must branch on the status
 * BEFORE deciding whether the completed-path invariants (commits / changed files)
 * apply, and the status may legitimately be `needs_input`, which is intentionally
 * NOT part of the AgentResult schema. So we validate only the envelope shape and
 * return the status string, avoiding an unchecked `as { status?: string }` cast.
 */
const runResultEnvelopeSchema = z.object({ status: z.string().optional() }).passthrough();

/**
 * Safely extract the run's `status` from a parsed `result.json` value. Returns
 * `undefined` when the value is not an object or has no string `status`.
 */
export function parseRunResultStatus(raw: unknown): string | undefined {
  const parsed = runResultEnvelopeSchema.safeParse(raw);
  return parsed.success ? parsed.data.status : undefined;
}
