import { describe, expect, it, vi } from "vitest";
import { reconcileMergedPullRequestsOnce } from "../src/reconcile.js";

const jobs = [
  { jobId: "job_1", repository: "acme/web", prNumber: 1, prUrl: "https://github.com/acme/web/pull/1" },
  { jobId: "job_2", repository: "acme/web", prNumber: 2, prUrl: "https://github.com/acme/web/pull/2" },
  { jobId: "job_3", repository: "acme/web", prNumber: 3, prUrl: "https://github.com/acme/web/pull/3" },
];

describe("reconcileMergedPullRequestsOnce", () => {
  it("marks merged PRs and leaves open ones untouched", async () => {
    const repos = {
      listJobsAwaitingMergeReconcile: vi.fn().mockResolvedValue(jobs),
      markPullRequestMerged: vi
        .fn()
        .mockResolvedValue({ status: "updated", jobId: "x", runId: "r", larkRecordId: "l", prUrl: "u", prNumber: 1 }),
    };
    // PR 1 merged, PR 2 still open, PR 3 merged.
    const checkMerged = vi.fn(async (_repo: string, prNumber: number) =>
      prNumber === 2 ? { merged: false } : { merged: true, mergedAt: "2026-06-21T00:00:00Z" },
    );

    const result = await reconcileMergedPullRequestsOnce(repos, checkMerged);

    expect(result).toEqual({ scanned: 3, merged: 2, pending: 1, errors: 0 });
    expect(repos.markPullRequestMerged).toHaveBeenCalledTimes(2);
    expect(repos.markPullRequestMerged).toHaveBeenCalledWith(
      expect.objectContaining({ repository: "acme/web", prNumber: 1, mergedAt: "2026-06-21T00:00:00Z" }),
    );
  });

  it("counts an already_terminal mark as resolved without recounting it as a new merge", async () => {
    const repos = {
      listJobsAwaitingMergeReconcile: vi.fn().mockResolvedValue([jobs[0]]),
      markPullRequestMerged: vi.fn().mockResolvedValue({
        status: "already_terminal",
        jobId: "x",
        runId: "r",
        larkRecordId: "l",
        prUrl: "u",
        prNumber: 1,
      }),
    };
    const checkMerged = vi.fn(async () => ({ merged: true }));

    const result = await reconcileMergedPullRequestsOnce(repos, checkMerged);

    expect(result).toEqual({ scanned: 1, merged: 0, pending: 0, errors: 0 });
    expect(repos.markPullRequestMerged).toHaveBeenCalledTimes(1);
  });

  it("is safe when the GitHub check throws or returns undefined (API unavailable)", async () => {
    const repos = {
      listJobsAwaitingMergeReconcile: vi.fn().mockResolvedValue([jobs[0], jobs[1]]),
      markPullRequestMerged: vi.fn(),
    };
    const checkMerged = vi.fn().mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce(undefined);

    const result = await reconcileMergedPullRequestsOnce(repos, checkMerged);

    expect(result).toEqual({ scanned: 2, merged: 0, pending: 0, errors: 2 });
    expect(repos.markPullRequestMerged).not.toHaveBeenCalled();
  });

  it("does not let a markPullRequestMerged failure abort the loop", async () => {
    const repos = {
      listJobsAwaitingMergeReconcile: vi.fn().mockResolvedValue([jobs[0], jobs[1]]),
      markPullRequestMerged: vi.fn().mockRejectedValueOnce(new Error("db blip")).mockResolvedValueOnce({
        status: "updated",
        jobId: "x",
        runId: "r",
        larkRecordId: "l",
        prUrl: "u",
        prNumber: 2,
      }),
    };
    const checkMerged = vi.fn(async () => ({ merged: true }));

    const result = await reconcileMergedPullRequestsOnce(repos, checkMerged);

    expect(result).toEqual({ scanned: 2, merged: 1, pending: 0, errors: 1 });
  });
});
