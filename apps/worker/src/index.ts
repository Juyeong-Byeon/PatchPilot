import { Worker as BullWorker } from "bullmq";
import { pathToFileURL } from "node:url";
import { createLarkRecordUpdater } from "@ticket-to-pr/core";
import { createPool, Repositories } from "@ticket-to-pr/db";
import { AGENT_JOB_QUEUE, buildWorkerReliabilityOptions, type AgentJobPayload } from "@ticket-to-pr/queue";
import { executeGstack } from "./executor-gstack.js";
import { executeMock } from "./executor-mock.js";
import { readWorkerEnv, type WorkerEnv } from "./env.js";
import { createGitHubPublisher } from "./publisher-github.js";
import { publishMockPullRequest } from "./publisher-mock.js";
import { createGitHubMergeChecker, startReconcilePoller, type ReconcilePollerHandle } from "./reconcile.js";
import { acquireJobExecutionLock } from "./execution-lock.js";
import {
  gcSuccessfulWorkspace,
  startWorkspaceLifecyclePoller,
  type WorkspaceLifecyclePollerHandle,
  type WorkspaceLifecycleConfig,
} from "./workspace-lifecycle.js";
import {
  processAgentJob,
  type Executor,
  type ExecutorMode,
  type Publisher,
  type WorkerRepositories,
} from "./worker.js";

export function createWorker(env: WorkerEnv = readWorkerEnv()): BullWorker<AgentJobPayload> {
  if (!env.databaseUrl) throw new Error("DATABASE_URL is required");

  const pool = createPool(env.databaseUrl);
  // L1: give the worker a heartbeat writer over the existing pool without changing
  // the db package — a raw `update runs set heartbeat_at=now()` added to the repo.
  const repos: WorkerRepositories = Object.assign(new Repositories(pool), {
    touchRunHeartbeat: async (runId: string): Promise<void> => {
      await pool.query("update runs set heartbeat_at=now() where id=$1", [runId]).catch(() => undefined);
    },
  });
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
    env.gstackArgs !== undefined ? (env.gstackArgs.includes("staged-runner") ? "staged" : "single-pass") : undefined;

  const lifecycleOnError = (context: string, error: unknown) =>
    console.warn(`workspace lifecycle ${context} failed:`, error instanceof Error ? error.message : error);

  // X6: explicit concurrency + lock duration + stalled-job recovery so a crashed
  // worker's in-flight job is reclaimed (and a long, alive run is never reaped).
  const worker = new BullWorker<AgentJobPayload>(
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
        // X6 execution dedup: a redelivered job no-ops if another worker holds the
        // job's advisory lock over the shared pool.
        acquireExecutionLock: (jobId) =>
          acquireJobExecutionLock(pool, jobId, (error) =>
            console.warn(`job execution lock error for ${jobId}:`, error instanceof Error ? error.message : error),
          ),
        // L1: periodic run heartbeat + GC the workspace once the PR is published.
        heartbeatIntervalMs: env.runHeartbeatIntervalMs,
        gcWorkspaceOnSuccess: (jobId) =>
          gcSuccessfulWorkspace(jobId, { workspaceRoot: env.workspaceRoot, onError: lifecycleOnError }),
      });
    },
    { connection: { url: env.redisUrl }, ...buildWorkerReliabilityOptions() },
  );

  // Surface stalled detections (a job re-delivered because its lock lapsed) so the
  // recovery path is observable. Execution dedup makes the redelivery itself safe.
  worker.on("stalled", (jobId) => {
    console.warn(`agent job stalled and was requeued: ${jobId}`);
  });

  return worker;
}

/**
 * Start the L1 workspace-lifecycle poller (failed-workspace retention sweep +
 * orphan runner-container reap). Returns the handle or null when disabled. The
 * `getActiveRunIds` callback lets the sweep skip containers/workspaces for runs the
 * worker still considers in flight; the standalone worker entrypoint passes an
 * always-empty set because BullMQ concurrency is serialized per process and a
 * still-running container is short-lived relative to the sweep interval.
 */
export function startWorkspaceLifecycle(
  env: WorkerEnv = readWorkerEnv(),
  getActiveRunIds: () => ReadonlySet<string> = () => new Set<string>(),
): WorkspaceLifecyclePollerHandle | null {
  if (env.workspaceSweepIntervalMs <= 0) return null;
  const config: WorkspaceLifecycleConfig & { intervalMs: number; getActiveRunIds: () => ReadonlySet<string> } = {
    workspaceRoot: env.workspaceRoot,
    failedRetentionDays: env.failedWorkspaceRetentionDays,
    intervalMs: env.workspaceSweepIntervalMs,
    getActiveRunIds,
    onError: (context, error) =>
      console.warn(`workspace lifecycle ${context} failed:`, error instanceof Error ? error.message : error),
  };
  return startWorkspaceLifecyclePoller(config);
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
  // L1: periodic workspace retention sweep + orphan runner-container reap.
  startWorkspaceLifecycle(env);
}
