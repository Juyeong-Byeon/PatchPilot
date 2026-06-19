export type Priority = "Low" | "Normal" | "High";

export type UserOutcome =
  | "Queued"
  | "Running"
  | "NeedsReview"
  | "FailedActionable"
  | "FailedInternal"
  | "Cancelled";

export type InternalPhase =
  | "Queued"
  | "Planning"
  | "Implementing"
  | "Reviewing"
  | "Testing"
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
