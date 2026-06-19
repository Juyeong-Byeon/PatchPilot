import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createSecretRedactor, maskSecrets, parseAgentResult, type AgentResult } from "@ticket-to-pr/core";
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

export interface TrustedGitEvidence {
  targetBranch: string;
  baseSha: string;
  headSha: string;
  pushSha: string;
  changedFiles: string[];
  commits: Array<{ sha: string; message: string }>;
}

export function buildGstackDockerCommand(input: GstackCommandInput): CommandSpec {
  return {
    file: "docker",
    args: [
      "run",
      "--rm",
      "--network",
      "bridge",
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
  const repositoryUrl = toRepositoryUrl(input.job.repository);
  const trustedBaseSha = await resolveRemoteTargetSha(repositoryUrl, input.job.targetBranch);
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
  const result = parseAgentResult(JSON.parse(await readFile(resultPath, "utf8")) as unknown);
  if (result.status !== "completed") return result;

  const trustedEvidence = await collectTrustedGitEvidence(
    getWorkspacePaths(input.run.workspacePath).repoDir,
    input.job.targetBranch,
    trustedBaseSha
  );
  return applyTrustedGitEvidence(result, trustedEvidence);
}

export function applyTrustedGitEvidence(result: AgentResult, evidence: TrustedGitEvidence): AgentResult {
  if (result.status !== "completed") return result;
  return parseAgentResult({
    ...result,
    targetBranch: evidence.targetBranch,
    baseSha: evidence.baseSha,
    headSha: evidence.headSha,
    pushSha: evidence.pushSha,
    changedFiles: evidence.changedFiles,
    commits: evidence.commits
  });
}

export async function resolveRemoteTargetSha(repositoryUrl: string, targetBranch: string): Promise<string> {
  const stdout = (await runGit(["ls-remote", "--heads", repositoryUrl, targetBranch])).stdout;
  const [sha] = stdout.trim().split(/\s+/);
  if (!sha) throw new Error(`Unable to resolve remote target branch ${targetBranch}`);
  return sha;
}

export async function collectTrustedGitEvidence(
  repoDir: string,
  targetBranch: string,
  baseSha: string
): Promise<TrustedGitEvidence> {
  const pushSha = (await runGit(["rev-parse", "--verify", "HEAD^{commit}"], repoDir)).stdout.trim();
  const headSha = pushSha;
  const changedFiles = (await runGit(["diff", "--name-only", `${baseSha}...${pushSha}`], repoDir)).stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const commits = (await runGit(["log", "--format=%H%x00%s", `${baseSha}..${pushSha}`], repoDir)).stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, ...messageParts] = line.split("\0");
      return { sha: sha ?? "", message: messageParts.join("\0") || sha || "Commit" };
    });

  return { targetBranch, baseSha, headSha, pushSha, changedFiles, commits };
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
  return { text: masked, redactionApplied: masked !== text || masked.includes("[REDACTED_") };
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
    const pendingLogs: Promise<void>[] = [];
    const stdoutRedactor = createSecretRedactor();
    const stderrRedactor = createSecretRedactor();

    const appendLog = (log: Parameters<NonNullable<ExecutorInput["appendLog"]>>[0]) => {
      if (input.appendLog) pendingLogs.push(input.appendLog(log));
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const masked = maskExecutorOutput(stdoutRedactor(chunk.toString("utf8")));
      appendLog({ source: "gstack", stream: "stdout", sequence: stdoutSequence++, ...masked });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const masked = maskExecutorOutput(stderrRedactor(chunk.toString("utf8")));
      appendLog({ source: "gstack", stream: "stderr", sequence: stderrSequence++, ...masked });
    });
    child.on("error", reject);
    child.on("close", async (code) => {
      const stdoutTail = stdoutRedactor("", true);
      if (stdoutTail) {
        const masked = maskExecutorOutput(stdoutTail);
        appendLog({ source: "gstack", stream: "stdout", sequence: stdoutSequence++, ...masked });
      }
      const stderrTail = stderrRedactor("", true);
      if (stderrTail) {
        const masked = maskExecutorOutput(stderrTail);
        appendLog({ source: "gstack", stream: "stderr", sequence: stderrSequence++, ...masked });
      }
      const logResults = await Promise.allSettled(pendingLogs);
      const rejectedLog = logResults.find((result) => result.status === "rejected");
      if (rejectedLog?.status === "rejected") {
        reject(rejectedLog.reason instanceof Error ? rejectedLog.reason : new Error(String(rejectedLog.reason)));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`gstack runner exited with code ${code ?? "unknown"}`));
    });
  });
}

function runGit(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`git ${args.join(" ")} failed with code ${code ?? "unknown"}: ${maskSecrets(stderr || stdout)}`));
    });
  });
}
