import { Worker as BullWorker } from "bullmq";
import { pathToFileURL } from "node:url";
import { createLarkRecordUpdater } from "@ticket-to-pr/core";
import { createPool, Repositories } from "@ticket-to-pr/db";
import { AGENT_JOB_QUEUE, type AgentJobPayload } from "@ticket-to-pr/queue";
import { executeGstack } from "./executor-gstack.js";
import { executeMock } from "./executor-mock.js";
import { readWorkerEnv, type WorkerEnv } from "./env.js";
import { createGitHubPublisher } from "./publisher-github.js";
import { publishMockPullRequest } from "./publisher-mock.js";
import { createGitHubMergeChecker, startReconcilePoller, type ReconcilePollerHandle } from "./reconcile.js";
import { processAgentJob, type Executor, type ExecutorMode, type Publisher } from "./worker.js";

export function createWorker(env: WorkerEnv = readWorkerEnv()): BullWorker<AgentJobPayload> {
  if (!env.databaseUrl) throw new Error("DATABASE_URL is required");

  const pool = createPool(env.databaseUrl);
  const repos = new Repositories(pool);
  const executor: Executor =
    env.executorMode === "mock"
      ? executeMock
      : (input) =>
          executeGstack(input, {
            runnerImage: env.runnerImage,
            timeoutSeconds: env.jobTimeoutSeconds,
            githubToken: env.githubToken,
            workspaceRoot: env.workspaceRoot,
            workspaceHostRoot: env.workspaceHostRoot,
            gstackCommand: env.gstackCommand,
            gstackArgs: env.gstackArgs,
            gstackStagedArgs: env.gstackStagedArgs,
            gstackSingleArgs: env.gstackSingleArgs,
            codexAuthFile: env.codexAuthFile,
            codexConfigFile: env.codexConfigFile,
            codexSkillsDir: env.codexSkillsDir,
            gstackSkillSourceDir: env.gstackSkillSourceDir,
            policy: {
              repositoryAllowlist: env.repositoryAllowlist,
              protectedPathDenylist: env.protectedPathDenylist,
            },
          });
  const publisher: Publisher =
    env.publisherMode === "mock" ? publishMockPullRequest : createGitHubPublisher(env.githubToken ?? "");
  const larkUpdater = env.larkRecordUpdaterConfig ? createLarkRecordUpdater(env.larkRecordUpdaterConfig) : undefined;

  // Back-compat: an explicit GSTACK_ARGS forces one pipeline for every job, so the
  // recorded executor mode must reflect that override rather than the priority.
  const executorModeOverride: ExecutorMode | undefined =
    env.gstackArgs !== undefined
      ? env.gstackArgs.includes("staged-runner")
        ? "staged"
        : "single-pass"
      : undefined;

  return new BullWorker<AgentJobPayload>(
    AGENT_JOB_QUEUE,
    async (job) => {
      await processAgentJob(job.data, {
        repos,
        executor,
        publisher,
        larkUpdater,
        policyConfig: {
          repositoryAllowlist: env.repositoryAllowlist,
          protectedPathDenylist: env.protectedPathDenylist,
        },
        workspaceRoot: env.workspaceRoot,
        executorModeOverride,
      });
    },
    { connection: { url: env.redisUrl } },
  );
}

/**
 * Start the merge-reconcile poller (X1) unless disabled. Returns the handle (so
 * tests/shutdown can stop it) or null when disabled or no GitHub token is present
 * (the poller needs the API to query merged state). Real-publisher worker only.
 */
export function startReconcile(repos: Repositories, env: WorkerEnv = readWorkerEnv()): ReconcilePollerHandle | null {
  if (env.reconcileIntervalMs <= 0) return null;
  if (env.publisherMode !== "github" || !env.githubToken) return null;
  return startReconcilePoller(repos, createGitHubMergeChecker(env.githubToken), {
    intervalMs: env.reconcileIntervalMs,
    onError: (error) => {
      // The poller must never crash the worker; surface but swallow.
      console.error("reconcile poller tick failed:", error instanceof Error ? error.message : error);
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = readWorkerEnv();
  createWorker(env);
  if (env.databaseUrl) {
    startReconcile(new Repositories(createPool(env.databaseUrl)), env);
  }
}
