export interface AgentJobPayload {
  jobId: string;
  ticketSnapshotId?: string;
  larkRecordId?: string;
  triggerVersion?: string;
  runId?: string;
  attempt?: number;
  /**
   * Operator retry-guidance (X4). When an operator retries a failed job with a
   * correction ("the previous attempt edited the wrong file — change X instead"),
   * the api track sets this on the redelivered payload. The worker injects it into
   * the runner's input context so the agent sees the steering. Optional and
   * forward-compatible: absent on first attempts and on retries without guidance.
   */
  retryGuidance?: string;
}

export const AGENT_JOB_QUEUE = "agent-jobs";
