import type { AgentResult } from "@ticket-to-pr/core";
import type { ExecutorInput } from "./worker.js";

export async function executeMock(input: ExecutorInput): Promise<AgentResult> {
  const title = input.job.title.length > 0 ? input.job.title : `Ticket ${input.job.ticketSnapshotId}`;

  return {
    schemaVersion: "1.0",
    runId: input.run.runId,
    jobId: input.job.jobId,
    ticketId: input.job.ticketSnapshotId,
    triggerVersion: input.job.triggerVersion,
    status: "completed",
    targetBranch: input.job.targetBranch,
    baseSha: "mock-base-sha",
    headSha: "mock-head-sha",
    changedFiles: [`mock/${input.job.jobId}.txt`],
    commits: [{ sha: "mock-commit-sha", message: title }],
    tests: [{ command: "mock test", status: "passed", summary: "Mock executor passed" }],
    review: {
      summary: `Mock implementation for ${title}`,
      risks: [],
      knownLimitations: ["Mock executor did not modify a real checkout"]
    },
    pullRequestDraft: {
      title: title.startsWith("Mock:") ? title : `Mock: ${title}`,
      bodyPath: "PR_BODY.md"
    },
    failure: null,
    retryable: false
  };
}
