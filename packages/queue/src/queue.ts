import { Queue } from "bullmq";
import type { AgentJobPayload } from "./jobs.js";
import { AGENT_JOB_QUEUE } from "./jobs.js";

export function createAgentQueue(redisUrl: string): Queue<AgentJobPayload> {
  return new Queue<AgentJobPayload>(AGENT_JOB_QUEUE, { connection: { url: redisUrl } });
}
