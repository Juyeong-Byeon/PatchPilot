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
import { processAgentJob, type Executor, type Publisher } from "./worker.js";

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
            codexAuthFile: env.codexAuthFile,
            codexConfigFile: env.codexConfigFile,
            codexSkillsDir: env.codexSkillsDir,
            gstackSkillSourceDir: env.gstackSkillSourceDir,
            policy: {
              repositoryAllowlist: env.repositoryAllowlist,
              protectedPathDenylist: env.protectedPathDenylist
            }
          });
  const publisher: Publisher =
    env.publisherMode === "mock" ? publishMockPullRequest : createGitHubPublisher(env.githubToken ?? "");
  const larkUpdater = env.larkRecordUpdaterConfig ? createLarkRecordUpdater(env.larkRecordUpdaterConfig) : undefined;

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
          protectedPathDenylist: env.protectedPathDenylist
        },
        workspaceRoot: env.workspaceRoot
      });
    },
    { connection: { url: env.redisUrl } }
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createWorker();
}
