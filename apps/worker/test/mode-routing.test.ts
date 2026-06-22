import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGstackArgs } from "../src/executor-gstack.js";
import { processAgentJob, resolveExecutorMode } from "../src/worker.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const completedResult = {
  schemaVersion: "1.0" as const,
  runId: "run_1",
  jobId: "job_1",
  ticketId: "ts_1",
  triggerVersion: "v1",
  status: "completed" as const,
  targetBranch: "main",
  baseSha: "0123456789abcdef0123456789abcdef01234567",
  headSha: "fedcba9876543210fedcba9876543210fedcba98",
  pushSha: "0123456789abcdef0123456789abcdef01234567",
  changedFiles: ["src/login.ts"],
  commits: [{ sha: "abc", message: "Fix login" }],
  tests: [{ command: "project verification", status: "skipped" as const, summary: "single-pass" }],
  review: { summary: "ok", risks: [], knownLimitations: [] },
  pullRequestDraft: { title: "Fix login", bodyPath: "PR_BODY.md" },
  failure: null,
  retryable: false,
};

function jobWith(priority: "Low" | "Normal" | "High", rawFields: Record<string, unknown> = {}) {
  return {
    jobId: "job_1",
    ticketSnapshotId: "ts_1",
    larkRecordId: "rec_1",
    triggerVersion: "v1",
    title: "Fix login",
    description: "Login fails",
    definitionOfDone: "- Users can log in",
    repository: "acme/web",
    targetBranch: "main",
    priority,
    phase: "Queued" as const,
    outcome: "Queued" as const,
    rawFields,
  };
}

function createRepos(job: ReturnType<typeof jobWith>) {
  return {
    getJobForWorker: vi.fn().mockResolvedValue(job),
    createRun: vi.fn().mockImplementation(async (input) => ({
      runId: input.id,
      jobId: input.jobId,
      attempt: input.attempt,
      workspacePath: input.workspacePath,
      workBranch: input.workBranch,
    })),
    transitionJob: vi.fn().mockResolvedValue(undefined),
    appendEvent: vi.fn().mockResolvedValue(undefined),
    appendLog: vi.fn().mockResolvedValue(undefined),
    saveArtifact: vi.fn().mockResolvedValue(undefined),
    savePullRequest: vi.fn().mockResolvedValue(undefined),
    appendAuditEvent: vi.fn().mockResolvedValue(undefined),
  };
}

describe("resolveExecutorMode", () => {
  it("keeps priority separate from pipeline selection", () => {
    expect(resolveExecutorMode(false)).toBe("single-pass");
    expect(resolveExecutorMode(true)).toBe("staged");
  });

  it("does not infer staged mode from a High priority ticket", () => {
    expect(resolveExecutorMode(false)).toBe("single-pass");
  });
});

describe("resolveGstackArgs", () => {
  it("selects staged/single args by mode", () => {
    const opts = { gstackStagedArgs: "ship --staged", gstackSingleArgs: "ship" };
    expect(resolveGstackArgs("staged", opts)).toBe("ship --staged");
    expect(resolveGstackArgs("single-pass", opts)).toBe("ship");
  });

  it("honors an explicit GSTACK_ARGS override for every mode", () => {
    const opts = { gstackArgs: "custom --args", gstackStagedArgs: "ship --staged", gstackSingleArgs: "ship" };
    expect(resolveGstackArgs("staged", opts)).toBe("custom --args");
    expect(resolveGstackArgs("single-pass", opts)).toBe("custom --args");
  });
});

describe("processAgentJob mode routing", () => {
  async function run(priority: "Low" | "Normal" | "High", rawFields: Record<string, unknown> = {}) {
    const job = jobWith(priority, rawFields);
    const repos = createRepos(job);
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ticket-to-pr-mode-"));
    tempDirs.push(workspaceRoot);
    let seenMode: string | undefined;
    const executor = vi.fn().mockImplementation(async (input) => {
      seenMode = input.executorMode;
      await writeFile(join(input.run.workspacePath, "PR_BODY.md"), "Body");
      return completedResult;
    });
    const publisher = vi.fn().mockImplementation(async (input) => ({
      repository: "acme/web",
      targetBranch: "main",
      workBranch: input.workBranch,
      baseSha: "base",
      headSha: "head",
      pushSha: "0123456789abcdef0123456789abcdef01234567",
      commitShas: ["abc"],
      prUrl: "https://github.local/acme/web/pull/mock-job_1",
      prNumber: 1,
      prTitle: input.title,
      prBody: input.body,
    }));

    await processAgentJob(
      { jobId: "job_1", ticketSnapshotId: "ts_1" },
      {
        repos,
        executor,
        publisher,
        workspaceRoot,
        policyConfig: { repositoryAllowlist: ["acme/web"], protectedPathDenylist: [] },
        ids: { runId: () => "run_1", artifactId: (k) => `a_${k}`, pullRequestId: () => "pr_1" },
      },
    );
    return { repos, seenMode };
  }

  it("picks single-pass for High priority when staged pipeline is not explicitly requested", async () => {
    const { repos, seenMode } = await run("High");
    expect(seenMode).toBe("single-pass");
    expect(repos.createRun).toHaveBeenCalledWith(expect.objectContaining({ executorMode: "single-pass" }));
    expect(repos.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "worker.executor_mode",
        metadata: expect.objectContaining({ executorMode: "single-pass", priority: "High" }),
      }),
    );
  });

  it("picks staged only when the ticket explicitly requests the staged pipeline", async () => {
    const { repos, seenMode } = await run("Normal", { "Staged Pipeline": true });
    expect(seenMode).toBe("staged");
    expect(repos.createRun).toHaveBeenCalledWith(expect.objectContaining({ executorMode: "staged" }));
    expect(repos.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "worker.executor_mode",
        metadata: expect.objectContaining({
          executorMode: "staged",
          priority: "Normal",
          stagedPipelineRequested: true,
        }),
      }),
    );
  });

  it("picks single-pass for Normal priority", async () => {
    const { repos, seenMode } = await run("Normal");
    expect(seenMode).toBe("single-pass");
    expect(repos.createRun).toHaveBeenCalledWith(expect.objectContaining({ executorMode: "single-pass" }));
  });

  it("respects an executorModeOverride regardless of priority", async () => {
    const job = jobWith("Normal");
    const repos = createRepos(job);
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ticket-to-pr-mode-ov-"));
    tempDirs.push(workspaceRoot);
    let seenMode: string | undefined;
    const executor = vi.fn().mockImplementation(async (input) => {
      seenMode = input.executorMode;
      await writeFile(join(input.run.workspacePath, "PR_BODY.md"), "Body");
      return completedResult;
    });
    const publisher = vi.fn().mockImplementation(async (input) => ({
      repository: "acme/web",
      targetBranch: "main",
      workBranch: input.workBranch,
      baseSha: "base",
      headSha: "head",
      pushSha: "0123456789abcdef0123456789abcdef01234567",
      commitShas: ["abc"],
      prUrl: "https://github.local/acme/web/pull/mock-job_1",
      prNumber: 1,
      prTitle: input.title,
      prBody: input.body,
    }));

    await processAgentJob(
      { jobId: "job_1", ticketSnapshotId: "ts_1" },
      {
        repos,
        executor,
        publisher,
        workspaceRoot,
        executorModeOverride: "staged",
        policyConfig: { repositoryAllowlist: ["acme/web"], protectedPathDenylist: [] },
        ids: { runId: () => "run_1", artifactId: (k) => `a_${k}`, pullRequestId: () => "pr_1" },
      },
    );

    expect(seenMode).toBe("staged");
    expect(repos.createRun).toHaveBeenCalledWith(expect.objectContaining({ executorMode: "staged" }));
  });
});

describe("processAgentJob effective settings (env ⊕ override)", () => {
  async function runWithSettings(priority: "Low" | "Normal" | "High", settings: { jobTimeoutSeconds: number }) {
    const job = jobWith(priority);
    const repos = createRepos(job);
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ticket-to-pr-settings-"));
    tempDirs.push(workspaceRoot);
    let seenMode: string | undefined;
    let seenTimeout: number | undefined;
    const executor = vi.fn().mockImplementation(async (input) => {
      seenMode = input.executorMode;
      seenTimeout = input.jobTimeoutSeconds;
      await writeFile(join(input.run.workspacePath, "PR_BODY.md"), "Body");
      return completedResult;
    });
    const publisher = vi.fn().mockImplementation(async (input) => ({
      repository: "acme/web",
      targetBranch: "main",
      workBranch: input.workBranch,
      baseSha: "base",
      headSha: "head",
      pushSha: "0123456789abcdef0123456789abcdef01234567",
      commitShas: ["abc"],
      prUrl: "https://github.local/acme/web/pull/mock-job_1",
      prNumber: 1,
      prTitle: input.title,
      prBody: input.body,
    }));

    await processAgentJob(
      { jobId: "job_1", ticketSnapshotId: "ts_1" },
      {
        repos,
        executor,
        publisher,
        workspaceRoot,
        policyConfig: { repositoryAllowlist: ["acme/web"], protectedPathDenylist: [] },
        loadJobSettings: async () => settings,
        ids: { runId: () => "run_1", artifactId: (k) => `a_${k}`, pullRequestId: () => "pr_1" },
      },
    );
    return { seenMode, seenTimeout };
  }

  it("threads the effective per-job timeout into the executor", async () => {
    const { seenTimeout } = await runWithSettings("Normal", { jobTimeoutSeconds: 600 });
    expect(seenTimeout).toBe(600);
  });

  it("keeps High priority on single-pass even with live settings loaded", async () => {
    const { seenMode } = await runWithSettings("High", { jobTimeoutSeconds: 3600 });
    expect(seenMode).toBe("single-pass");
  });

  it("falls back to defaults (no executor timeout) when no loader is provided", async () => {
    const job = jobWith("Normal");
    const repos = createRepos(job);
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ticket-to-pr-settings-none-"));
    tempDirs.push(workspaceRoot);
    let seenTimeout: number | undefined;
    const executor = vi.fn().mockImplementation(async (input) => {
      seenTimeout = input.jobTimeoutSeconds;
      await writeFile(join(input.run.workspacePath, "PR_BODY.md"), "Body");
      return completedResult;
    });
    const publisher = vi.fn().mockImplementation(async (input) => ({
      repository: "acme/web",
      targetBranch: "main",
      workBranch: input.workBranch,
      baseSha: "base",
      headSha: "head",
      pushSha: "0123456789abcdef0123456789abcdef01234567",
      commitShas: ["abc"],
      prUrl: "https://github.local/acme/web/pull/mock-job_1",
      prNumber: 1,
      prTitle: input.title,
      prBody: input.body,
    }));

    await processAgentJob(
      { jobId: "job_1", ticketSnapshotId: "ts_1" },
      {
        repos,
        executor,
        publisher,
        workspaceRoot,
        policyConfig: { repositoryAllowlist: ["acme/web"], protectedPathDenylist: [] },
        ids: { runId: () => "run_1", artifactId: (k) => `a_${k}`, pullRequestId: () => "pr_1" },
      },
    );
    // The default loader returns the registry default (3600), passed to the executor.
    expect(seenTimeout).toBe(3600);
  });
});
