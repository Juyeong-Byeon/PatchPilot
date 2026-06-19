export interface AgentJobPayload {
  jobId: string;
  ticketSnapshotId: string;
  larkRecordId: string;
  triggerVersion: string;
}

export const AGENT_JOB_QUEUE = "agent-jobs";
