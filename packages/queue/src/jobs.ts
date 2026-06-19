export interface AgentJobPayload {
  jobId: string;
  ticketSnapshotId?: string;
  larkRecordId?: string;
  triggerVersion?: string;
  runId?: string;
  attempt?: number;
}

export const AGENT_JOB_QUEUE = "agent-jobs";
