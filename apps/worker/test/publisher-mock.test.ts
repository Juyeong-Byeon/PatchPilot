import { describe, expect, it } from "vitest";
import { publishMockPullRequest } from "../src/publisher-mock.js";

describe("publishMockPullRequest", () => {
  it("returns deterministic pull request metadata from an AgentResult", async () => {
    const published = await publishMockPullRequest({
      jobId: "job_1",
      runId: "run_1",
      repository: "acme/web",
      targetBranch: "main",
      workBranch: "ticket-to-pr/job_1",
      baseSha: "base",
      headSha: "head",
      commitShas: ["abc"],
      title: "Fix login",
      body: "Summary"
    });

    expect(published).toEqual({
      repository: "acme/web",
      targetBranch: "main",
      workBranch: "ticket-to-pr/job_1",
      baseSha: "base",
      headSha: "head",
      commitShas: ["abc"],
      prUrl: "https://github.local/acme/web/pull/mock-job_1",
      prNumber: 1,
      prTitle: "Fix login",
      prBody: "Summary"
    });
  });
});
