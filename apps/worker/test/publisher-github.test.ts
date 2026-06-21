import { describe, expect, it, vi } from "vitest";
import { publishGitHubPullRequest } from "../src/publisher-github.js";

const PUBLISH_INPUT = {
  jobId: "job_1",
  runId: "run_1",
  repository: "acme/web",
  targetBranch: "main",
  workBranch: "ticket-to-pr/job_1",
  localRepoDir: "/work/jobs/job_1/repo",
  baseSha: "base",
  headSha: "head",
  pushSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
  commitShas: ["abc"],
  title: "Fix login",
  body: "Summary",
};

describe("publishGitHubPullRequest", () => {
  it("creates a ready-for-review GitHub pull request through Octokit", async () => {
    const octokit = {
      rest: {
        pulls: {
          list: vi.fn().mockResolvedValue({ data: [] }),
          update: vi.fn(),
          create: vi.fn().mockResolvedValue({
            data: { html_url: "https://github.com/acme/web/pull/42", number: 42 },
          }),
        },
      },
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
        pushSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
        commitShas: ["abc"],
        title: "Fix login",
        body: "Summary",
      },
      octokit,
      pushBranch,
      "github_pat_secret",
    );

    expect(pushBranch).toHaveBeenCalledWith(
      "/work/jobs/job_1/repo",
      "ticket-to-pr/job_1",
      "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      "github_pat_secret",
    );
    expect(octokit.rest.pulls.create).toHaveBeenCalledWith({
      owner: "acme",
      repo: "web",
      title: "Fix login",
      body: "Summary",
      head: "ticket-to-pr/job_1",
      base: "main",
      draft: false,
    });
    expect(published).toMatchObject({
      prUrl: "https://github.com/acme/web/pull/42",
      prNumber: 42,
      prTitle: "Fix login",
    });
  });

  it("reuses an existing open PR (updates it) instead of creating a duplicate", async () => {
    const octokit = {
      rest: {
        pulls: {
          list: vi.fn().mockResolvedValue({
            data: [{ html_url: "https://github.com/acme/web/pull/7", number: 7 }],
          }),
          update: vi.fn().mockResolvedValue({
            data: { html_url: "https://github.com/acme/web/pull/7", number: 7 },
          }),
          create: vi.fn(),
        },
      },
    };

    const published = await publishGitHubPullRequest(
      PUBLISH_INPUT,
      octokit,
      vi.fn().mockResolvedValue(undefined),
      "github_pat_secret",
    );

    expect(octokit.rest.pulls.list).toHaveBeenCalledWith(
      expect.objectContaining({ head: "acme:ticket-to-pr/job_1", base: "main", state: "open" }),
    );
    expect(octokit.rest.pulls.create).not.toHaveBeenCalled();
    expect(octokit.rest.pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 7, body: "Summary" }),
    );
    expect(published).toMatchObject({ prNumber: 7, prUrl: "https://github.com/acme/web/pull/7" });
  });

  it("reuses after the orphan-branch case (push succeeded, prior create failed)", async () => {
    // The branch was already pushed on a prior attempt, so a retry finds an open PR.
    const octokit = {
      rest: {
        pulls: {
          list: vi.fn().mockResolvedValue({
            data: [{ html_url: "https://github.com/acme/web/pull/7", number: 7 }],
          }),
          update: vi.fn().mockResolvedValue({
            data: { html_url: "https://github.com/acme/web/pull/7", number: 7 },
          }),
          create: vi.fn(),
        },
      },
    };
    const pushBranch = vi.fn().mockResolvedValue(undefined);

    const published = await publishGitHubPullRequest(PUBLISH_INPUT, octokit, pushBranch, "github_pat_secret");

    expect(pushBranch).toHaveBeenCalledTimes(1);
    expect(octokit.rest.pulls.create).not.toHaveBeenCalled();
    expect(published.prNumber).toBe(7);
  });

  it("falls back to create when the open-PR lookup fails", async () => {
    const octokit = {
      rest: {
        pulls: {
          list: vi.fn().mockRejectedValue(new Error("403 forbidden")),
          update: vi.fn(),
          create: vi.fn().mockResolvedValue({
            data: { html_url: "https://github.com/acme/web/pull/9", number: 9 },
          }),
        },
      },
    };

    const published = await publishGitHubPullRequest(
      PUBLISH_INPUT,
      octokit,
      vi.fn().mockResolvedValue(undefined),
      "github_pat_secret",
    );

    expect(octokit.rest.pulls.create).toHaveBeenCalledTimes(1);
    expect(octokit.rest.pulls.update).not.toHaveBeenCalled();
    expect(published.prNumber).toBe(9);
  });
});
