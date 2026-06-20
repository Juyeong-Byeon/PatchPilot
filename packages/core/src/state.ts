import type { InternalPhase, UserOutcome } from "./types.js";

const allowed: Record<InternalPhase, InternalPhase[]> = {
  Queued: ["Planning", "CancelRequested", "Failed"],
  Planning: ["Implementing", "CancelRequested", "Failed"],
  Implementing: ["Reviewing", "Testing", "CancelRequested", "Failed"],
  Reviewing: ["Testing", "CancelRequested", "Failed"],
  Testing: ["PolicyChecking", "CancelRequested", "Failed"],
  PolicyChecking: ["Publishing", "Failed"],
  Publishing: ["Completed", "Failed"],
  Completed: [],
  Failed: [],
  CancelRequested: ["Cancelling", "CancelFailed"],
  Cancelling: ["Cancelled", "CancelFailed"],
  Cancelled: [],
  CancelFailed: ["Failed"],
};

export function transitionPhase(current: InternalPhase, next: InternalPhase): InternalPhase {
  if (!allowed[current].includes(next)) {
    throw new Error(`Invalid phase transition: ${current} -> ${next}`);
  }
  return next;
}

export function deriveOutcome(phase: InternalPhase): UserOutcome {
  if (phase === "Queued") return "Queued";
  if (phase === "Completed") return "NeedsReview";
  if (phase === "Cancelled") return "Cancelled";
  if (phase === "Failed" || phase === "CancelFailed") return "FailedInternal";
  return "Running";
}
