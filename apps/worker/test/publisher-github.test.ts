import { describe, expect, it, vi } from "vitest";
import { publishGitHubPullRequest } from "../src/publisher-github.js";

describe("publishGitHubPullRequest", () => {
  it("creates a GitHub pull request through Octokit", async () => {
    const octokit = {
      rest: {
        pulls: {
          create: vi.fn().mockResolvedValue({
            data: { html_url: "https://github.com/acme/web/pull/42", number: 42 }
          })
        }
      }
    };

    const pushBranch = vi.fn().mockResolvedValue(undefined);
    const published = await publishGitHubPullRequest(
      {
        jobId: "job_1",
        runId: "run_1",
        repository: "acme/web",
        targetBranch: "main",
        workBranch: "ticket-to-pr/job_1",
        localRepoDir: "/work/jobs/job_1/repo",
        baseSha: "base",
        headSha: "head",
        commitShas: ["abc"],
        title: "Fix login",
        body: "Summary"
      },
      octokit,
      pushBranch
    );

    expect(pushBranch).toHaveBeenCalledWith("/work/jobs/job_1/repo", "ticket-to-pr/job_1");
    expect(octokit.rest.pulls.create).toHaveBeenCalledWith({
      owner: "acme",
      repo: "web",
      title: "Fix login",
      body: "Summary",
      head: "ticket-to-pr/job_1",
      base: "main",
      draft: true
    });
    expect(published).toMatchObject({
      prUrl: "https://github.com/acme/web/pull/42",
      prNumber: 42,
      prTitle: "Fix login"
    });
  });
});
