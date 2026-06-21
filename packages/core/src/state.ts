import type { InternalPhase, UserOutcome } from "./types.js";

const allowed: Record<InternalPhase, InternalPhase[]> = {
  // A running stage may park the job on a blocking question (-> AwaitingInput)
  // from any of the working phases. AwaitingInput is the runner reporting it
  // needs human input; the worker writes the transition.
  Queued: ["Planning", "AwaitingInput", "CancelRequested", "Failed"],
  Planning: ["Implementing", "AwaitingInput", "CancelRequested", "Failed"],
  Implementing: ["Reviewing", "Testing", "AwaitingInput", "CancelRequested", "Failed"],
  Reviewing: ["Testing", "AwaitingInput", "CancelRequested", "Failed"],
  Testing: ["PolicyChecking", "AwaitingInput", "CancelRequested", "Failed"],
  // Parked on a human answer. Resuming re-queues the SAME job (a new attempt
  // seeded with the operator's answer as guidance), so the only forward edge is
  // back to Queued. A cancel may still abandon a parked question.
  AwaitingInput: ["Queued", "CancelRequested", "Failed"],
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
  if (phase === "AwaitingInput") return "NeedsInput";
  if (phase === "Completed") return "NeedsReview";
  if (phase === "Cancelled") return "Cancelled";
  if (phase === "Failed" || phase === "CancelFailed") return "FailedInternal";
  return "Running";
}
