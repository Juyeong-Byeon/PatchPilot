export type Priority = "Low" | "Normal" | "High";

export type UserOutcome =
  | "Queued"
  | "Running"
  // The agent asked a question only a human can answer and the job is PARKED
  // waiting for that answer (NeedsInput capability). Non-terminal: an operator
  // answer re-queues the same job with the answer injected as run guidance.
  | "NeedsInput"
  | "NeedsReview"
  | "Completed"
  | "FailedActionable"
  | "FailedInternal"
  | "Cancelled";

export type InternalPhase =
  | "Queued"
  | "Planning"
  | "Implementing"
  | "Reviewing"
  | "Testing"
  // Parked: a running stage wrote needs-input.json with a blocking question, so
  // the job is held (no PR, no failure) until an operator answers. The answer
  // resumes the job by transitioning AwaitingInput -> Queued (a fresh attempt).
  | "AwaitingInput"
  | "PolicyChecking"
  | "Publishing"
  | "Completed"
  | "Failed"
  | "CancelRequested"
  | "Cancelling"
  | "Cancelled"
  | "CancelFailed";

export interface TicketSnapshotInput {
  larkRecordId: string;
  triggerVersion: string;
  title: string;
  description: string;
  definitionOfDone: string;
  repository: string;
  targetBranch: string;
  priority: Priority;
  status: string;
  agentRunRequested: boolean;
  rawFields: Record<string, unknown>;
}
