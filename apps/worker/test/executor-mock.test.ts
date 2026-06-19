import { describe, expect, it } from "vitest";
import { executeMock } from "../src/executor-mock.js";

const job = {
  jobId: "job_1",
  ticketSnapshotId: "ts_1",
  larkRecordId: "rec_1",
  triggerVersion: "v1",
  title: "Fix login",
  description: "Login fails",
  definitionOfDone: "Users can log in",
  repository: "acme/web",
  targetBranch: "main",
  priority: "Normal" as const,
  phase: "Queued" as const,
  outcome: "Queued" as const,
  rawFields: {}
};

describe("executeMock", () => {
  it("returns a completed AgentResult with commit, test, and PR draft evidence", async () => {
    const result = await executeMock({
      job,
      run: { runId: "run_1", attempt: 1, workspacePath: "/tmp/work", workBranch: "ticket-to-pr/job_1" }
    });

    expect(result).toMatchObject({
      schemaVersion: "1.0",
      runId: "run_1",
      jobId: "job_1",
      ticketId: "ts_1",
      triggerVersion: "v1",
      status: "completed",
      targetBranch: "main",
      failure: null,
      retryable: false
    });
    expect(result.changedFiles).toEqual(["mock/job_1.txt"]);
    expect(result.commits).toHaveLength(1);
    expect(result.tests[0]).toMatchObject({ status: "passed" });
    expect(result.pullRequestDraft?.title).toContain("Fix login");
  });
});
