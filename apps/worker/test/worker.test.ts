import { describe, expect, it, vi } from "vitest";
import { processAgentJob } from "../src/worker.js";

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

const completedResult = {
  schemaVersion: "1.0" as const,
  runId: "run_1",
  jobId: "job_1",
  ticketId: "ts_1",
  triggerVersion: "v1",
  status: "completed" as const,
  targetBranch: "main",
  baseSha: "base",
  headSha: "head",
  changedFiles: ["src/login.ts"],
  commits: [{ sha: "abc", message: "Fix login" }],
  tests: [{ command: "npm test", status: "passed" as const, summary: "ok" }],
  review: { summary: "ok", risks: [], knownLimitations: [] },
  pullRequestDraft: { title: "Fix login", bodyPath: "PR_BODY.md" },
  failure: null,
  retryable: false
};

function createRepos() {
  return {
    getJobForWorker: vi.fn().mockResolvedValue(job),
    createRun: vi.fn().mockImplementation(async (input) => ({
      runId: input.id,
      jobId: input.jobId,
      attempt: input.attempt,
      workspacePath: input.workspacePath,
      workBranch: input.workBranch
    })),
    transitionJob: vi.fn().mockResolvedValue(undefined),
    appendEvent: vi.fn().mockResolvedValue(undefined),
    appendLog: vi.fn().mockResolvedValue(undefined),
    saveArtifact: vi.fn().mockResolvedValue(undefined),
    savePullRequest: vi.fn().mockResolvedValue(undefined),
    appendAuditEvent: vi.fn().mockResolvedValue(undefined)
  };
}

describe("processAgentJob", () => {
  it("executes, stores artifacts, publishes, and completes a mock-safe job", async () => {
    const repos = createRepos();
    const executor = vi.fn().mockResolvedValue(completedResult);
    const publisher = vi.fn().mockResolvedValue({
      repository: "acme/web",
      targetBranch: "main",
      workBranch: "ticket-to-pr/job_1",
      baseSha: "base",
      headSha: "head",
      commitShas: ["abc"],
      prUrl: "https://github.local/acme/web/pull/mock-job_1",
      prNumber: 1,
      prTitle: "Fix login",
      prBody: "Generated body"
    });

    const outcome = await processAgentJob(
      { jobId: "job_1", ticketSnapshotId: "ts_1", larkRecordId: "rec_1", triggerVersion: "v1" },
      {
        repos,
        executor,
        publisher,
        policyConfig: { repositoryAllowlist: ["acme/web"], protectedPathDenylist: ["infra/**"] },
        ids: {
          runId: () => "run_1",
          artifactId: (kind) => `artifact_${kind}`,
          pullRequestId: () => "pr_1"
        }
      }
    );

    expect(outcome).toEqual({ status: "completed", runId: "run_1" });
    expect(repos.saveArtifact).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent-result" }));
    expect(repos.saveArtifact).toHaveBeenCalledWith(expect.objectContaining({ kind: "policy-gate" }));
    expect(publisher).toHaveBeenCalledWith(expect.objectContaining({ title: "Fix login" }));
    expect(repos.savePullRequest).toHaveBeenCalledWith(expect.objectContaining({ id: "pr_1", prUrl: expect.any(String) }));
    expect(repos.transitionJob).toHaveBeenLastCalledWith("job_1", "Completed", "NeedsReview");
  });

  it("stores policy gate artifacts and fails actionable when protected files change", async () => {
    const repos = createRepos();
    const executor = vi.fn().mockResolvedValue({ ...completedResult, changedFiles: ["infra/prod.tf"] });
    const publisher = vi.fn();

    const outcome = await processAgentJob(
      { jobId: "job_1", ticketSnapshotId: "ts_1", larkRecordId: "rec_1", triggerVersion: "v1" },
      {
        repos,
        executor,
        publisher,
        policyConfig: { repositoryAllowlist: ["acme/web"], protectedPathDenylist: ["infra/**"] },
        ids: {
          runId: () => "run_1",
          artifactId: (kind) => `artifact_${kind}`,
          pullRequestId: () => "pr_1"
        }
      }
    );

    expect(outcome.status).toBe("policy_blocked");
    expect(publisher).not.toHaveBeenCalled();
    expect(repos.saveArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "policy-gate",
        content: expect.objectContaining({ status: "failed", deniedFiles: ["infra/prod.tf"] })
      })
    );
    expect(repos.transitionJob).toHaveBeenLastCalledWith(
      "job_1",
      "Failed",
      "FailedActionable",
      expect.stringContaining("infra/prod.tf")
    );
  });

  it("accepts retry payloads with preassigned run id and attempt", async () => {
    const repos = createRepos();
    const executor = vi.fn().mockResolvedValue({ ...completedResult, runId: "run_2" });
    const publisher = vi.fn().mockResolvedValue({
      repository: "acme/web",
      targetBranch: "main",
      workBranch: "ticket-to-pr/job_1",
      baseSha: "base",
      headSha: "head",
      commitShas: ["abc"],
      prUrl: "https://github.local/acme/web/pull/mock-job_1",
      prNumber: 1,
      prTitle: "Fix login",
      prBody: "Generated body"
    });

    const outcome = await processAgentJob(
      { jobId: "job_1", runId: "run_2", attempt: 2 },
      {
        repos,
        executor,
        publisher,
        policyConfig: { repositoryAllowlist: ["acme/web"], protectedPathDenylist: [] },
        ids: {
          runId: () => "unused",
          artifactId: (kind) => `artifact_${kind}`,
          pullRequestId: () => "pr_1"
        }
      }
    );

    expect(outcome).toEqual({ status: "completed", runId: "run_2" });
    expect(repos.createRun).toHaveBeenCalledWith(expect.objectContaining({ id: "run_2", attempt: 2 }));
    expect(executor).toHaveBeenCalledWith(expect.objectContaining({ run: expect.objectContaining({ attempt: 2 }) }));
  });

  it("stops before execution when cancel was already requested", async () => {
    const repos = createRepos();
    repos.getJobForWorker.mockResolvedValue({ ...job, phase: "CancelRequested", outcome: "Running" });
    const executor = vi.fn();
    const publisher = vi.fn();

    const outcome = await processAgentJob(
      { jobId: "job_1", ticketSnapshotId: "ts_1" },
      {
        repos,
        executor,
        publisher,
        policyConfig: { repositoryAllowlist: ["acme/web"], protectedPathDenylist: [] },
        ids: {
          runId: () => "run_1",
          artifactId: (kind) => `artifact_${kind}`,
          pullRequestId: () => "pr_1"
        }
      }
    );

    expect(outcome).toEqual({ status: "cancelled", runId: "run_1" });
    expect(executor).not.toHaveBeenCalled();
    expect(publisher).not.toHaveBeenCalled();
    expect(repos.transitionJob).toHaveBeenLastCalledWith("job_1", "Cancelled", "Cancelled");
  });
});
