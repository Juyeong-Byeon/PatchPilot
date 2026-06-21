import { type InternalPhase, transitionPhase } from "@ticket-to-pr/core";

/**
 * The full domain of {@link InternalPhase}. This is the *enumeration* of the type
 * (kept in sync with packages/core/src/types.ts), not the transition rules — the
 * rules live solely in core's `transitionPhase` whitelist, which this module
 * probes. Keeping the rules in one place means the DB guard can never drift from
 * the worker's in-memory state machine.
 */
export const ALL_PHASES: readonly InternalPhase[] = [
  "Queued",
  "Planning",
  "Implementing",
  "Reviewing",
  "Testing",
  "AwaitingInput",
  "PolicyChecking",
  "Publishing",
  "Completed",
  "Failed",
  "CancelRequested",
  "Cancelling",
  "Cancelled",
  "CancelFailed",
];

/**
 * Truly-terminal phases: core's whitelist gives them no outgoing transition, so
 * a row in one of these must never be overwritten. NOTE `CancelFailed` is
 * deliberately excluded — core still allows `CancelFailed -> Failed`, so it is
 * not immutable and must not block that transition at the DB layer.
 */
export const TERMINAL_PHASES: readonly InternalPhase[] = ["Completed", "Failed", "Cancelled"];

export function isTerminalPhase(phase: InternalPhase): boolean {
  return TERMINAL_PHASES.includes(phase);
}

/**
 * Returns every phase from which `transitionPhase(from, next)` is allowed by
 * core's whitelist. Used to build the `where phase = any($expectedFrom)` guard so
 * the DB rejects exactly the transitions the in-memory state machine rejects.
 */
export function phasesAllowedToTransitionTo(next: InternalPhase): InternalPhase[] {
  return ALL_PHASES.filter((from) => {
    if (from === next) return false; // a no-op self-transition is never a real advance
    try {
      transitionPhase(from, next);
      return true;
    } catch {
      return false;
    }
  });
}
