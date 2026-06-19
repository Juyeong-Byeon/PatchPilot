import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { maskSecrets, parseAgentResult, type AgentResult } from "@ticket-to-pr/core";
import { getWorkspacePaths } from "@ticket-to-pr/runner-contract";
import type { ExecutorInput } from "./worker.js";

export interface GstackCommandInput {
  runnerImage: string;
  workspacePath: string;
  job: {
    jobId: string;
    ticketSnapshotId: string;
    larkRecordId: string;
    triggerVersion: string;
    repository: string;
    targetBranch: string;
  };
  run: {
    runId: string;
    attempt: number;
    workBranch: string;
  };
  timeoutSeconds?: number;
}

export interface CommandSpec {
  file: string;
  args: string[];
}

export interface GstackExecutorOptions {
  runnerImage: string;
  resultPath?: string;
  timeoutSeconds?: number;
  policy?: {
    repositoryAllowlist: string[];
    protectedPathDenylist: string[];
  };
}

export function buildGstackDockerCommand(input: GstackCommandInput): CommandSpec {
  return {
    file: "docker",
    args: [
      "run",
      "--rm",
      "--network",
      "none",
      "--cpus",
      "2",
      "--memory",
      "4g",
      "-v",
      `${input.workspacePath}:/work/jobs/${input.job.jobId}`,
      "-e",
      `JOB_ID=${input.job.jobId}`,
      "-e",
      `RUN_ID=${input.run.runId}`,
      "-e",
      `WORKSPACE_ROOT=/work/jobs/${input.job.jobId}`,
      "-e",
      `REPOSITORY_URL=${toRepositoryUrl(input.job.repository)}`,
      "-e",
      `TARGET_BRANCH=${input.job.targetBranch}`,
      "-e",
      `WORK_BRANCH=${input.run.workBranch}`,
      "-e",
      `TIMEOUT_SECONDS=${input.timeoutSeconds ?? 3600}`,
      input.runnerImage
    ]
  };
}

export async function executeGstack(input: ExecutorInput, options: GstackExecutorOptions): Promise<AgentResult> {
  const command = buildGstackDockerCommand({
    runnerImage: options.runnerImage,
    workspacePath: input.run.workspacePath,
    job: input.job,
    run: input.run,
    timeoutSeconds: options.timeoutSeconds
  });

  await writeRunnerInputArtifacts({
    workspacePath: input.run.workspacePath,
    job: input.job,
    run: input.run,
    policy: options.policy ?? { repositoryAllowlist: [], protectedPathDenylist: [] }
  });
  await runCommand(command, input);

  const resultPath = options.resultPath ?? getWorkspacePaths(input.run.workspacePath).resultJson;
  const result = JSON.parse(await readFile(resultPath, "utf8")) as unknown;
  return parseAgentResult(result);
}

export async function writeRunnerInputArtifacts(input: {
  workspacePath: string;
  job: {
    jobId: string;
    ticketSnapshotId: string;
    larkRecordId: string;
    triggerVersion: string;
    title: string;
    description: string;
    definitionOfDone: string;
    repository: string;
    targetBranch: string;
  };
  run: {
    runId: string;
    attempt: number;
    workBranch: string;
  };
  policy: {
    repositoryAllowlist: string[];
    protectedPathDenylist: string[];
  };
}): Promise<void> {
  const paths = getWorkspacePaths(input.workspacePath);
  await mkdir(paths.inputDir, { recursive: true });
  await writeFile(paths.ticketMd, renderTicketMarkdown(input.job));
  await writeFile(
    paths.contextJson,
    `${JSON.stringify(
      {
        jobId: input.job.jobId,
        ticketSnapshotId: input.job.ticketSnapshotId,
        larkRecordId: input.job.larkRecordId,
        triggerVersion: input.job.triggerVersion,
        runId: input.run.runId,
        attempt: input.run.attempt,
        workBranch: input.run.workBranch
      },
      null,
      2
    )}\n`
  );
  await writeFile(paths.policyJson, `${JSON.stringify(input.policy, null, 2)}\n`);
}

export function maskExecutorOutput(text: string): { text: string; redactionApplied: boolean } {
  const masked = maskSecrets(text);
  return { text: masked, redactionApplied: masked !== text };
}

function renderTicketMarkdown(job: {
  title: string;
  description: string;
  definitionOfDone: string;
  repository: string;
  targetBranch: string;
}): string {
  return [
    `# ${job.title}`,
    "",
    "## Description",
    job.description,
    "",
    "## Definition of Done",
    job.definitionOfDone,
    "",
    "## Repository",
    job.repository,
    "",
    "## Target Branch",
    job.targetBranch,
    ""
  ].join("\n");
}

function toRepositoryUrl(repository: string): string {
  if (/^(https?:\/\/|git@)/.test(repository)) return repository;
  return `https://github.com/${repository}.git`;
}

async function runCommand(command: CommandSpec, input: ExecutorInput): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.file, command.args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdoutSequence = 0;
    let stderrSequence = 0;

    child.stdout.on("data", (chunk: Buffer) => {
      const masked = maskExecutorOutput(chunk.toString("utf8"));
      void input.appendLog?.({ source: "gstack", stream: "stdout", sequence: stdoutSequence++, ...masked });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const masked = maskExecutorOutput(chunk.toString("utf8"));
      void input.appendLog?.({ source: "gstack", stream: "stderr", sequence: stderrSequence++, ...masked });
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`gstack runner exited with code ${code ?? "unknown"}`));
    });
  });
}
