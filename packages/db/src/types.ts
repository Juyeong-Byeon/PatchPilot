export interface CreateJobResult {
  jobId: string;
  ticketSnapshotId: string;
  created: boolean;
}

export interface AppendEventInput {
  jobId: string;
  runId?: string;
  attempt?: number;
  phase: string;
  eventType: string;
  source: string;
  message: string;
  metadata?: unknown;
}
