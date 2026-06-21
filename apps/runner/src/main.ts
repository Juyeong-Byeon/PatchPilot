import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRunResultStatus, readJsonArtifact, readTextArtifact } from "@ticket-to-pr/runner-contract";
import { checkoutBaseAndCreateBranch, cloneRepository, getChangedFiles, getHeadSha, hasLocalCommit } from "./git.js";
import { runGstack } from "./gstack.js";
import { prepareWorkspace } from "./workspace.js";

export interface RunnerConfig {
  jobId: string;
  runId: string;
  workspaceRoot: string;
  repositoryUrl: string;
  targetBranch: string;
  workBranch: string;
  timeoutSeconds: number;
}

export async function runRunner(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = readConfig(env);
  const paths = await prepareWorkspace(config.workspaceRoot);
  const gstackLog = path.join(paths.logsDir, "gstack.log");

  console.log(`Starting runner job ${config.jobId} run ${config.runId}`);
  await cloneRepository(config.repositoryUrl, paths.repoDir);
  await checkoutBaseAndCreateBranch(paths.repoDir, config.targetBranch, config.workBranch);
  delete process.env.GITHUB_TOKEN;

  const baseSha = await getHeadSha(paths.repoDir);
  console.log(`Checked out ${config.workBranch} from ${config.targetBranch} at ${baseSha}`);

  await runGstack(paths.repoDir, gstackLog, config.timeoutSeconds * 1000);

  // result.json is the source of truth for the run's outcome. A run that PARKED on
  // operator input (status "needs_input") or reported a structured failure
  // (status "failed") legitimately produces no commits, so only the completed path
  // enforces commits/changed-files. Exiting cleanly here lets the worker read
  // result.json and act on the real status — instead of a non-zero exit turning a
  // valid parked/failed outcome into an "exited with code 1" infra crash.
  await requireFile(paths.resultJson);
  const status = parseRunResultStatus(await readJsonArtifact(paths.resultJson));

  if (status === "needs_input") {
    console.log("Runner parked: agent requested operator input (needs-input.json); no changes pushed");
    return;
  }
  if (status === "failed") {
    console.log("Runner reported a structured failure; no changes pushed");
    return;
  }

  await verifyRequiredArtifacts(paths.resultJson, paths.prTitle, paths.prBody);

  if (!(await hasLocalCommit(paths.repoDir, config.targetBranch))) {
    throw new Error(`gstack completed but created no local commits on ${config.workBranch}`);
  }

  const changedFiles = await getChangedFiles(paths.repoDir, config.targetBranch);
  if (changedFiles.length === 0) {
    throw new Error(`gstack completed but produced no changed files against ${config.targetBranch}`);
  }

  const headSha = await getHeadSha(paths.repoDir);
  console.log(`Runner completed: head=${headSha} changedFiles=${changedFiles.length}`);
}

function readConfig(env: NodeJS.ProcessEnv): RunnerConfig {
  const timeoutSeconds = Number(readRequiredEnv(env, "TIMEOUT_SECONDS"));
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("TIMEOUT_SECONDS must be a positive number");
  }

  return {
    jobId: readRequiredEnv(env, "JOB_ID"),
    runId: readRequiredEnv(env, "RUN_ID"),
    workspaceRoot: readRequiredEnv(env, "WORKSPACE_ROOT"),
    repositoryUrl: readRequiredEnv(env, "REPOSITORY_URL"),
    targetBranch: readRequiredEnv(env, "TARGET_BRANCH"),
    workBranch: readRequiredEnv(env, "WORK_BRANCH"),
    timeoutSeconds,
  };
}

function readRequiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

async function verifyRequiredArtifacts(resultJson: string, prTitle: string, prBody: string): Promise<void> {
  await requireFile(resultJson);
  await requireFile(prTitle);
  await requireFile(prBody);

  await readJsonArtifact(resultJson);
  const title = (await readTextArtifact(prTitle)).trim();
  const body = (await readTextArtifact(prBody)).trim();

  if (!title) {
    throw new Error(`Required artifact is empty: ${prTitle}`);
  }

  if (!body) {
    throw new Error(`Required artifact is empty: ${prBody}`);
  }
}

async function requireFile(filePath: string): Promise<void> {
  try {
    await access(filePath);
  } catch (error) {
    throw new Error(`Missing required artifact: ${filePath}`, { cause: error });
  }
}

const mainPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (mainPath === fileURLToPath(import.meta.url)) {
  runRunner().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
