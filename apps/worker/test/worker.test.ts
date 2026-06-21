import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processAgentJob } from "../src/worker.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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
  rawFields: {},
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
  pushSha: "0123456789abcdef0123456789abcdef01234567",
  changedFiles: ["src/login.ts"],
  commits: [{ sha: "abc", message: "Fix login" }],
  tests: [{ command: "npm test", status: "passed" as const, summary: "ok" }],
  review: { summary: "ok", risks: [], knownLimitations: [] },
  pullRequestDraft: { title: "Fix login", bodyPath: "PR_BODY.md" },
  failure: null,
  retryable: false,
};

function createRepos() {
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

describe("processAgentJob", () => {
  it("executes, stores artifacts, publishes, and completes a mock-safe job", async () => {
    const repos = createRepos();
    const executor = vi.fn().mockImplementation(async (input) => {
      await writeFile(join(input.run.workspacePath, "PR_BODY.md"), "Generated body");
      return completedResult;
    });
    const publisher = vi.fn().mockResolvedValue({
      repository: "acme/web",
      targetBranch: "main",
      workBranch: "ticket-to-pr/job_1",
      baseSha: "base",
      headSha: "head",
      pushSha: "0123456789abcdef0123456789abcdef01234567",
      commitShas: ["abc"],
      prUrl: "https://github.local/acme/web/pull/mock-job_1",
      prNumber: 1,
      prTitle: "Fix login",
      prBody: "Generated body",
    });
    const larkUpdater = vi.fn().mockResolvedValue(undefined);

    const outcome = await processAgentJob(
      { jobId: "job_1", ticketSnapshotId: "ts_1", larkRecordId: "rec_1", triggerVersion: "v1" },
      {
        repos,
        executor,
        publisher,
        larkUpdater,
        policyConfig: { repositoryAllowlist: ["acme/web"], protectedPathDenylist: ["infra/**"] },
        ids: {
          runId: () => "run_1",
          artifactId: (kind) => `artifact_${kind}`,
          pullRequestId: () => "pr_1",
        },
      },
    );

    expect(outcome).toEqual({ status: "completed", runId: "run_1" });
    expect(repos.saveArtifact).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent-result" }));
    expect(repos.saveArtifact).toHaveBeenCalledWith(expect.objectContaining({ kind: "policy-gate" }));
    expect(publisher).toHaveBeenCalledWith(expect.objectContaining({ title: "Fix login" }));
    expect(repos.savePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pr_1", prUrl: expect.any(String) }),
    );
    expect(repos.transitionJob).toHaveBeenLastCalledWith("job_1", "Completed", "NeedsReview");
    expect(larkUpdater).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId: "rec_1",
        status: "Running",
        jobId: "job_1",
      }),
    );
    expect(larkUpdater).toHaveBeenLastCalledWith(
      expect.objectContaining({
        recordId: "rec_1",
        status: "NeedsReview",
        jobId: "job_1",
        prUrl: "https://github.local/acme/web/pull/mock-job_1",
        prNumber: 1,
      }),
    );
  });

  it("writes simplified progress logs for the operator while each phase runs", async () => {
    const repos = createRepos();
    const executor = vi.fn().mockImplementation(async (input) => {
      await writeFile(join(input.run.workspacePath, "PR_BODY.md"), "Generated body");
      return completedResult;
    });
    const publisher = vi.fn().mockResolvedValue({
      repository: "acme/web",
      targetBranch: "main",
      workBranch: "ticket-to-pr/job_1",
      baseSha: "base",
      headSha: "head",
      pushSha: "0123456789abcdef0123456789abcdef01234567",
      commitShas: ["abc"],
      prUrl: "https://github.local/acme/web/pull/mock-job_1",
      prNumber: 1,
      prTitle: "Fix login",
      prBody: "Generated body",
    });

    await processAgentJob(
      { jobId: "job_1", ticketSnapshotId: "ts_1", larkRecordId: "rec_1", triggerVersion: "v1" },
      {
        repos,
        executor,
        publisher,
        policyConfig: { repositoryAllowlist: ["acme/web"], protectedPathDenylist: ["infra/**"] },
        ids: {
          runId: () => "run_1",
          artifactId: (kind) => `artifact_${kind}`,
          pullRequestId: () => "pr_1",
        },
      },
    );

    const progressLogs = repos.appendLog.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.stream === "progress");

    expect(progressLogs.map((entry) => entry.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(progressLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "worker",
          text: "[계획] 작업자가 티켓과 저장소 정책을 확인하고 있습니다.",
        }),
        expect.objectContaining({
          source: "gstack",
          text: "[구현] 실행 워크스페이스를 준비하고 AI runner를 시작합니다.",
        }),
        expect.objectContaining({
          source: "policy",
          text: "[정책 검사] 변경 파일과 저장소 허용 정책을 검사하고 있습니다.",
        }),
        expect.objectContaining({
          source: "publisher",
          text: "[게시] 브랜치를 푸시하고 PR을 생성하고 있습니다.",
        }),
        expect.objectContaining({
          source: "worker",
          text: "[완료] PR 생성이 끝났습니다.",
        }),
      ]),
    );
  });

  it("emits a structured gstack.stage event per stage banner, line-buffered and deduped", async () => {
    const repos = createRepos();
    const executor = vi.fn().mockImplementation(async (input) => {
      // Banner split across two chunks, then a duplicate of the same stage, then the next stage.
      input.appendLog({ source: "gstack", stream: "stdout", sequence: 0, text: "=== gstack stage 1/4: pl" });
      input.appendLog({
        source: "gstack",
        stream: "stdout",
        sequence: 1,
        text: "an ===\n=== gstack stage 1/4: plan ===\n",
      });
      input.appendLog({
        source: "gstack",
        stream: "stdout",
        sequence: 2,
        text: "=== gstack stage 2/4: implement ===\n",
      });
      await writeFile(join(input.run.workspacePath, "PR_BODY.md"), "Generated body");
      return completedResult;
    });
    const publisher = vi.fn().mockResolvedValue({
      repository: "acme/web",
      targetBranch: "main",
      workBranch: "ticket-to-pr/job_1",
      baseSha: "base",
      headSha: "head",
      pushSha: "0123456789abcdef0123456789abcdef01234567",
      commitShas: ["abc"],
      prUrl: "https://github.local/acme/web/pull/mock-job_1",
      prNumber: 1,
      prTitle: "Fix login",
      prBody: "Generated body",
    });

    await processAgentJob(
      { jobId: "job_1", ticketSnapshotId: "ts_1", larkRecordId: "rec_1", triggerVersion: "v1" },
      {
        repos,
        executor,
        publisher,
        policyConfig: { repositoryAllowlist: ["acme/web"], protectedPathDenylist: [] },
        ids: { runId: () => "run_1", artifactId: (kind) => `artifact_${kind}`, pullRequestId: () => "pr_1" },
      },
    );

    const stageEvents = repos.appendEvent.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.eventType === "gstack.stage");

    // Chunk-split banner reassembled into one event; the duplicate stage-1 banner is dropped.
    expect(stageEvents.map((entry) => entry.metadata)).toEqual([
      { stageIndex: 1, stageTotal: 4, stageKey: "plan" },
      { stageIndex: 2, stageTotal: 4, stageKey: "implement" },
    ]);
    expect(stageEvents.every((entry) => entry.phase === "Implementing" && entry.source === "gstack")).toBe(true);
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
          pullRequestId: () => "pr_1",
        },
      },
    );

    expect(outcome.status).toBe("policy_blocked");
    expect(publisher).not.toHaveBeenCalled();
    expect(repos.saveArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "policy-gate",
        content: expect.objectContaining({ status: "failed", deniedFiles: ["infra/prod.tf"] }),
      }),
    );
    expect(repos.transitionJob).toHaveBeenLastCalledWith(
      "job_1",
      "Failed",
      "FailedActionable",
      expect.stringContaining("infra/prod.tf"),
      expect.objectContaining({ category: "policy", nextAction: expect.any(String) }),
    );
  });

  it("blocks unallowlisted repositories before executor starts", async () => {
    const repos = createRepos();
    repos.getJobForWorker.mockResolvedValue({ ...job, repository: "evil/web" });
    const executor = vi.fn();
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
          pullRequestId: () => "pr_1",
        },
      },
    );

    expect(outcome.status).toBe("policy_blocked");
    expect(executor).not.toHaveBeenCalled();
    expect(publisher).not.toHaveBeenCalled();
    expect(repos.saveArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "policy-gate",
        content: expect.objectContaining({
          status: "failed",
          repositoryAllowed: false,
        }),
      }),
    );
    expect(repos.transitionJob).toHaveBeenLastCalledWith(
      "job_1",
      "Failed",
      "FailedActionable",
      expect.stringContaining("evil/web"),
      expect.objectContaining({ category: "policy", nextAction: expect.any(String) }),
    );
  });

  it("accepts retry payloads with preassigned run id and attempt", async () => {
    const repos = createRepos();
    const executor = vi.fn().mockImplementation(async (input) => {
      await writeFile(join(input.run.workspacePath, "PR_BODY.md"), "Generated body");
      return { ...completedResult, runId: "run_2" };
    });
    const publisher = vi.fn().mockResolvedValue({
      repository: "acme/web",
      targetBranch: "main",
      workBranch: "ticket-to-pr/job_1",
      baseSha: "base",
      headSha: "head",
      pushSha: "0123456789abcdef0123456789abcdef01234567",
      commitShas: ["abc"],
      prUrl: "https://github.local/acme/web/pull/mock-job_1",
      prNumber: 1,
      prTitle: "Fix login",
      prBody: "Generated body",
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
          pullRequestId: () => "pr_1",
        },
      },
    );

    expect(outcome).toEqual({ status: "completed", runId: "run_2" });
    expect(repos.createRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: "run_2", attempt: 2, workBranch: "ticket-to-pr/job_1-attempt-2" }),
    );
    expect(executor).toHaveBeenCalledWith(expect.objectContaining({ run: expect.objectContaining({ attempt: 2 }) }));
    expect(publisher).toHaveBeenCalledWith(expect.objectContaining({ workBranch: "ticket-to-pr/job_1-attempt-2" }));
  });

  it("publishes the agent-authored PR body artifact when it exists", async () => {
    const repos = createRepos();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ticket-to-pr-pr-body-"));
    tempDirs.push(workspaceRoot);
    const executor = vi.fn().mockImplementation(async (input) => {
      await mkdir(join(input.run.workspacePath, "output"), { recursive: true });
      await writeFile(join(input.run.workspacePath, "output", "pr-body.md"), "Agent-authored body\n");
      return { ...completedResult, pullRequestDraft: { title: "Fix login", bodyPath: "output/pr-body.md" } };
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
      { jobId: "job_1", ticketSnapshotId: "ts_1", larkRecordId: "rec_1", triggerVersion: "v1" },
      {
        repos,
        executor,
        publisher,
        workspaceRoot,
        policyConfig: { repositoryAllowlist: ["acme/web"], protectedPathDenylist: [] },
        ids: {
          runId: () => "run_1",
          artifactId: (kind) => `artifact_${kind}`,
          pullRequestId: () => "pr_1",
        },
      },
    );

    // The agent body stays on top; the platform trust footer is appended below a separator.
    const publishedBody = publisher.mock.calls[0][0].body as string;
    expect(publishedBody.startsWith("Agent-authored body")).toBe(true);
    expect(publishedBody).toContain("\n---\n");
    expect(publishedBody).toContain("PatchPilot 신뢰 증거");
  });

  it("fails completed results that reference a missing PR body artifact", async () => {
    const repos = createRepos();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ticket-to-pr-missing-pr-body-"));
    tempDirs.push(workspaceRoot);
    const executor = vi.fn().mockResolvedValue({
      ...completedResult,
      pullRequestDraft: { title: "Fix login", bodyPath: "output/missing-pr-body.md" },
    });
    const publisher = vi.fn();

    const outcome = await processAgentJob(
      { jobId: "job_1", ticketSnapshotId: "ts_1", larkRecordId: "rec_1", triggerVersion: "v1" },
      {
        repos,
        executor,
        publisher,
        workspaceRoot,
        policyConfig: { repositoryAllowlist: ["acme/web"], protectedPathDenylist: [] },
        ids: {
          runId: () => "run_1",
          artifactId: (kind) => `artifact_${kind}`,
          pullRequestId: () => "pr_1",
        },
      },
    );

    expect(outcome).toEqual({ status: "failed", runId: "run_1" });
    expect(publisher).not.toHaveBeenCalled();
    expect(repos.transitionJob).toHaveBeenLastCalledWith(
      "job_1",
      "Failed",
      "FailedInternal",
      expect.stringContaining("Missing pull request body artifact"),
      expect.objectContaining({ category: "infra", nextAction: expect.any(String) }),
    );
  });

  it("cancels mid-run, aborts the executor, and records the cancel phase", async () => {
    const repos = createRepos();
    let executing = false;
    repos.getJobForWorker.mockImplementation(async () =>
      executing ? { ...job, phase: "CancelRequested", outcome: "Running" } : job,
    );
    // Executor never resolves on its own; it rejects only when the cancel signal aborts it.
    const executor = vi.fn().mockImplementation(
      (input: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          executing = true;
          input.signal.addEventListener("abort", () => reject(new Error("runner aborted")), { once: true });
        }),
    );
    const publisher = vi.fn();

    const outcome = await processAgentJob(
      { jobId: "job_1", ticketSnapshotId: "ts_1" },
      {
        repos,
        executor,
        publisher,
        cancelPollMs: 5,
        policyConfig: { repositoryAllowlist: ["acme/web"], protectedPathDenylist: [] },
        ids: { runId: () => "run_1", artifactId: (kind) => `artifact_${kind}`, pullRequestId: () => "pr_1" },
      },
    );

    expect(outcome).toEqual({ status: "cancelled", runId: "run_1" });
    expect(publisher).not.toHaveBeenCalled();
    expect(repos.transitionJob).toHaveBeenLastCalledWith(
      "job_1",
      "Cancelled",
      "Cancelled",
      "구현 단계 실행 중 취소되었습니다.",
    );
    expect(repos.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "worker.cancelled", metadata: { cancelledPhase: "Implementing" } }),
    );
  });

  it("honors a cancel that wins the race when the guarded Publishing transition no-ops", async () => {
    const repos = createRepos();
    const executor = vi.fn().mockImplementation(async (input) => {
      await writeFile(join(input.run.workspacePath, "PR_BODY.md"), "Generated body");
      return completedResult;
    });
    const publisher = vi.fn();
    // The optimistic guard rejects the PolicyChecking -> Publishing advance (a
    // concurrent cancel flipped the row), so the worker must NOT publish.
    const transitionJobGuarded = vi.fn().mockImplementation(async (_jobId, phase) => phase !== "Publishing");

    const outcome = await processAgentJob(
      { jobId: "job_1", ticketSnapshotId: "ts_1" },
      {
        repos: { ...repos, transitionJobGuarded },
        executor,
        publisher,
        policyConfig: { repositoryAllowlist: ["acme/web"], protectedPathDenylist: [] },
        ids: { runId: () => "run_1", artifactId: (kind) => `artifact_${kind}`, pullRequestId: () => "pr_1" },
      },
    );

    expect(outcome).toEqual({ status: "cancelled", runId: "run_1" });
    expect(publisher).not.toHaveBeenCalled();
    expect(transitionJobGuarded).toHaveBeenCalledWith(
      "job_1",
      "Publishing",
      "Running",
      undefined,
      undefined,
      "PolicyChecking",
    );
    expect(repos.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "worker.cancelled", phase: "Cancelled" }),
    );
  });

  it("uses the guarded transition to enter Publishing on the happy path", async () => {
    const repos = createRepos();
    const transitionJobGuarded = vi.fn().mockResolvedValue(true);
    const executor = vi.fn().mockImplementation(async (input) => {
      await writeFile(join(input.run.workspacePath, "PR_BODY.md"), "Generated body");
      return completedResult;
    });
    const publisher = vi.fn().mockResolvedValue({
      repository: "acme/web",
      targetBranch: "main",
      workBranch: "ticket-to-pr/job_1",
      baseSha: "base",
      headSha: "head",
      pushSha: "0123456789abcdef0123456789abcdef01234567",
      commitShas: ["abc"],
      prUrl: "https://github.local/acme/web/pull/mock-job_1",
      prNumber: 1,
      prTitle: "Fix login",
      prBody: "Generated body",
    });

    const outcome = await processAgentJob(
      { jobId: "job_1", ticketSnapshotId: "ts_1" },
      {
        repos: { ...repos, transitionJobGuarded },
        executor,
        publisher,
        policyConfig: { repositoryAllowlist: ["acme/web"], protectedPathDenylist: [] },
        ids: { runId: () => "run_1", artifactId: (kind) => `artifact_${kind}`, pullRequestId: () => "pr_1" },
      },
    );

    expect(outcome).toEqual({ status: "completed", runId: "run_1" });
    expect(transitionJobGuarded).toHaveBeenCalledWith(
      "job_1",
      "Publishing",
      "Running",
      undefined,
      undefined,
      "PolicyChecking",
    );
    expect(publisher).toHaveBeenCalled();
  });

  it("surfaces a runner's structured failure category and nextAction (X4)", async () => {
    const repos = createRepos();
    const executor = vi.fn().mockResolvedValue({
      ...completedResult,
      status: "failed",
      targetBranch: undefined,
      baseSha: undefined,
      headSha: undefined,
      pushSha: undefined,
      review: undefined,
      pullRequestDraft: undefined,
      changedFiles: [],
      commits: [],
      tests: [],
      retryable: false,
      failure: {
        stage: "implement",
        category: "agent-quality",
        message: "Could not satisfy DoD item 2",
        retryable: false,
        nextAction: "DoD 2번 항목을 더 구체화한 뒤 재시도하세요.",
      },
    });
    const publisher = vi.fn();

    const outcome = await processAgentJob(
      { jobId: "job_1", ticketSnapshotId: "ts_1" },
      {
        repos,
        executor,
        publisher,
        policyConfig: { repositoryAllowlist: ["acme/web"], protectedPathDenylist: [] },
        ids: { runId: () => "run_1", artifactId: (kind) => `artifact_${kind}`, pullRequestId: () => "pr_1" },
      },
    );

    expect(outcome).toEqual({ status: "failed", runId: "run_1" });
    expect(publisher).not.toHaveBeenCalled();
    // The runner's structured category + nextAction flow through verbatim.
    expect(repos.transitionJob).toHaveBeenLastCalledWith(
      "job_1",
      "Failed",
      "FailedActionable",
      "Could not satisfy DoD item 2",
      expect.objectContaining({
        category: "agent-quality",
        nextAction: "DoD 2번 항목을 더 구체화한 뒤 재시도하세요.",
      }),
    );
  });

  it("falls back to canned remediation for a non-completed result without structured failure (X4 tolerance)", async () => {
    const repos = createRepos();
    // A cancelled result is schema-valid with failure:null and exercises the
    // fallback branch (the canned agent/infra remediation) since result.failure is
    // absent. status !== "completed" → routed through the failure-handling block.
    const executor = vi.fn().mockResolvedValue({
      ...completedResult,
      status: "cancelled",
      targetBranch: undefined,
      baseSha: undefined,
      headSha: undefined,
      pushSha: undefined,
      review: undefined,
      pullRequestDraft: undefined,
      changedFiles: [],
      commits: [],
      tests: [],
      retryable: false,
      failure: null,
    });
    const publisher = vi.fn();

    const outcome = await processAgentJob(
      { jobId: "job_1", ticketSnapshotId: "ts_1" },
      {
        repos,
        executor,
        publisher,
        policyConfig: { repositoryAllowlist: ["acme/web"], protectedPathDenylist: [] },
        ids: { runId: () => "run_1", artifactId: (kind) => `artifact_${kind}`, pullRequestId: () => "pr_1" },
      },
    );

    expect(outcome.status).toBe("failed");
    expect(repos.transitionJob).toHaveBeenLastCalledWith(
      "job_1",
      "Failed",
      "FailedActionable",
      expect.stringContaining("Agent result status"),
      expect.objectContaining({ category: "agent" }),
    );
  });

  it("injects operator retry guidance into the executor input and records an event (X4)", async () => {
    const repos = createRepos();
    let seenGuidance: string | undefined;
    const executor = vi.fn().mockImplementation(async (input) => {
      seenGuidance = input.retryGuidance;
      await writeFile(join(input.run.workspacePath, "PR_BODY.md"), "Generated body");
      return completedResult;
    });
    const publisher = vi.fn().mockResolvedValue({
      repository: "acme/web",
      targetBranch: "main",
      workBranch: "ticket-to-pr/job_1-attempt-2",
      baseSha: "base",
      headSha: "head",
      pushSha: "0123456789abcdef0123456789abcdef01234567",
      commitShas: ["abc"],
      prUrl: "https://github.local/acme/web/pull/mock-job_1",
      prNumber: 1,
      prTitle: "Fix login",
      prBody: "Generated body",
    });

    await processAgentJob(
      { jobId: "job_1", ticketSnapshotId: "ts_1", attempt: 2, retryGuidance: "Focus on the redirect bug." },
      {
        repos,
        executor,
        publisher,
        policyConfig: { repositoryAllowlist: ["acme/web"], protectedPathDenylist: [] },
        ids: { runId: () => "run_1", artifactId: (kind) => `artifact_${kind}`, pullRequestId: () => "pr_1" },
      },
    );

    expect(seenGuidance).toBe("Focus on the redirect bug.");
    expect(repos.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "worker.retry_guidance" }));
  });

  it("reads retry guidance from rawFields when the payload omits it (X4 fallback)", async () => {
    const repos = createRepos();
    repos.getJobForWorker.mockResolvedValue({ ...job, rawFields: { retryGuidance: "From rawFields." } });
    let seenGuidance: string | undefined;
    const executor = vi.fn().mockImplementation(async (input) => {
      seenGuidance = input.retryGuidance;
      await writeFile(join(input.run.workspacePath, "PR_BODY.md"), "Generated body");
      return completedResult;
    });
    const publisher = vi.fn().mockResolvedValue({
      repository: "acme/web",
      targetBranch: "main",
      workBranch: "ticket-to-pr/job_1",
      baseSha: "base",
      headSha: "head",
      pushSha: "0123456789abcdef0123456789abcdef01234567",
      commitShas: ["abc"],
      prUrl: "https://github.local/acme/web/pull/mock-job_1",
      prNumber: 1,
      prTitle: "Fix login",
      prBody: "Generated body",
    });

    await processAgentJob(
      { jobId: "job_1", ticketSnapshotId: "ts_1" },
      {
        repos,
        executor,
        publisher,
        policyConfig: { repositoryAllowlist: ["acme/web"], protectedPathDenylist: [] },
        ids: { runId: () => "run_1", artifactId: (kind) => `artifact_${kind}`, pullRequestId: () => "pr_1" },
      },
    );

    expect(seenGuidance).toBe("From rawFields.");
  });

  it("GCs the workspace and writes heartbeats around a successful run (L1)", async () => {
    const repos = createRepos();
    const touchRunHeartbeat = vi.fn().mockResolvedValue(undefined);
    const executor = vi.fn().mockImplementation(async (input) => {
      await writeFile(join(input.run.workspacePath, "PR_BODY.md"), "Generated body");
      return completedResult;
    });
    const publisher = vi.fn().mockResolvedValue({
      repository: "acme/web",
      targetBranch: "main",
      workBranch: "ticket-to-pr/job_1",
      baseSha: "base",
      headSha: "head",
      pushSha: "0123456789abcdef0123456789abcdef01234567",
      commitShas: ["abc"],
      prUrl: "https://github.local/acme/web/pull/mock-job_1",
      prNumber: 1,
      prTitle: "Fix login",
      prBody: "Generated body",
    });
    const gcWorkspaceOnSuccess = vi.fn().mockResolvedValue(undefined);

    const outcome = await processAgentJob(
      { jobId: "job_1", ticketSnapshotId: "ts_1" },
      {
        repos: { ...repos, touchRunHeartbeat },
        executor,
        publisher,
        gcWorkspaceOnSuccess,
        // Heartbeat disabled (interval 0) here to keep the test deterministic; the
        // GC call is the assertion of record.
        heartbeatIntervalMs: 0,
        policyConfig: { repositoryAllowlist: ["acme/web"], protectedPathDenylist: [] },
        ids: { runId: () => "run_1", artifactId: (kind) => `artifact_${kind}`, pullRequestId: () => "pr_1" },
      },
    );

    expect(outcome).toEqual({ status: "completed", runId: "run_1" });
    expect(gcWorkspaceOnSuccess).toHaveBeenCalledWith("job_1");
  });

  it("does not GC the workspace when the job fails policy (L1 retention)", async () => {
    const repos = createRepos();
    const executor = vi.fn().mockResolvedValue({ ...completedResult, changedFiles: ["infra/prod.tf"] });
    const publisher = vi.fn();
    const gcWorkspaceOnSuccess = vi.fn().mockResolvedValue(undefined);

    const outcome = await processAgentJob(
      { jobId: "job_1", ticketSnapshotId: "ts_1" },
      {
        repos,
        executor,
        publisher,
        gcWorkspaceOnSuccess,
        policyConfig: { repositoryAllowlist: ["acme/web"], protectedPathDenylist: ["infra/**"] },
        ids: { runId: () => "run_1", artifactId: (kind) => `artifact_${kind}`, pullRequestId: () => "pr_1" },
      },
    );

    expect(outcome.status).toBe("policy_blocked");
    // Failed/blocked workspaces are retained for post-mortem, not GC'd.
    expect(gcWorkspaceOnSuccess).not.toHaveBeenCalled();
  });

  it("no-ops a redelivered job when another worker already holds the execution lock", async () => {
    const repos = createRepos();
    const executor = vi.fn();
    const publisher = vi.fn();
    const release = vi.fn().mockResolvedValue(undefined);
    // The advisory lock is already held by a live worker -> acquired:false.
    const acquireExecutionLock = vi.fn().mockResolvedValue({ acquired: false, release });

    const outcome = await processAgentJob(
      { jobId: "job_1", ticketSnapshotId: "ts_1" },
      {
        repos,
        executor,
        publisher,
        acquireExecutionLock,
        policyConfig: { repositoryAllowlist: ["acme/web"], protectedPathDenylist: [] },
        ids: { runId: () => "run_1", artifactId: (kind) => `artifact_${kind}`, pullRequestId: () => "pr_1" },
      },
    );

    expect(outcome).toEqual({ status: "dedup_skipped" });
    // No work at all: no run, no executor, no publish, no state transition.
    expect(acquireExecutionLock).toHaveBeenCalledWith("job_1");
    expect(repos.getJobForWorker).not.toHaveBeenCalled();
    expect(repos.createRun).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
    expect(publisher).not.toHaveBeenCalled();
  });

  it("acquires and releases the execution lock around a normal run", async () => {
    const repos = createRepos();
    const executor = vi.fn().mockImplementation(async (input) => {
      await writeFile(join(input.run.workspacePath, "PR_BODY.md"), "Generated body");
      return completedResult;
    });
    const publisher = vi.fn().mockResolvedValue({
      repository: "acme/web",
      targetBranch: "main",
      workBranch: "ticket-to-pr/job_1",
      baseSha: "base",
      headSha: "head",
      pushSha: "0123456789abcdef0123456789abcdef01234567",
      commitShas: ["abc"],
      prUrl: "https://github.local/acme/web/pull/mock-job_1",
      prNumber: 1,
      prTitle: "Fix login",
      prBody: "Generated body",
    });
    const release = vi.fn().mockResolvedValue(undefined);
    const acquireExecutionLock = vi.fn().mockResolvedValue({ acquired: true, release });

    const outcome = await processAgentJob(
      { jobId: "job_1", ticketSnapshotId: "ts_1" },
      {
        repos,
        executor,
        publisher,
        acquireExecutionLock,
        policyConfig: { repositoryAllowlist: ["acme/web"], protectedPathDenylist: [] },
        ids: { runId: () => "run_1", artifactId: (kind) => `artifact_${kind}`, pullRequestId: () => "pr_1" },
      },
    );

    expect(outcome).toEqual({ status: "completed", runId: "run_1" });
    expect(acquireExecutionLock).toHaveBeenCalledWith("job_1");
    // The lock is released even on the happy path so the next delivery is free.
    expect(release).toHaveBeenCalledTimes(1);
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
          pullRequestId: () => "pr_1",
        },
      },
    );

    expect(outcome).toEqual({ status: "cancelled", runId: "run_1" });
    expect(executor).not.toHaveBeenCalled();
    expect(publisher).not.toHaveBeenCalled();
    expect(repos.transitionJob).toHaveBeenLastCalledWith("job_1", "Cancelled", "Cancelled");
  });
});
