import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createSecretRedactor, maskSecrets, parseAgentResult, type AgentResult } from "@ticket-to-pr/core";
import { getWorkspacePaths } from "@ticket-to-pr/runner-contract";
import { buildSafeGitArgs } from "./git-safe.js";
import type { ExecutorInput } from "./worker.js";

export interface GstackCommandInput {
  runnerImage: string;
  workspacePath: string;
  workspaceMountSource?: string;
  gstackCommand?: string | undefined;
  gstackArgs?: string | undefined;
  codexAuthFile?: string | undefined;
  codexConfigFile?: string | undefined;
  codexSkillsDir?: string | undefined;
  gstackSkillSourceDir?: string | undefined;
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
  timeoutSeconds?: number | undefined;
  githubToken?: string | undefined;
}

export interface CommandSpec {
  file: string;
  args: string[];
}

export interface GstackExecutorOptions {
  runnerImage: string;
  resultPath?: string;
  timeoutSeconds?: number;
  githubToken?: string | undefined;
  workspaceRoot?: string;
  workspaceHostRoot?: string | undefined;
  gstackCommand?: string | undefined;
  /**
   * Explicit GSTACK_ARGS override (back-compat). When set it is used verbatim for
   * every job regardless of mode. When unset, args are selected per-job from the
   * executor mode via {@link gstackStagedArgs} / {@link gstackSingleArgs}.
   */
  gstackArgs?: string | undefined;
  /** GSTACK_ARGS for the staged pipeline (input.executorMode === "staged"). */
  gstackStagedArgs?: string;
  /** GSTACK_ARGS for the single-pass pipeline (default). */
  gstackSingleArgs?: string;
  codexAuthFile?: string | undefined;
  codexConfigFile?: string | undefined;
  codexSkillsDir?: string | undefined;
  gstackSkillSourceDir?: string | undefined;
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
  const authArgs = input.githubToken ? ["-e", `GITHUB_TOKEN=${input.githubToken}`] : [];
  const gstackCommandArgs = input.gstackCommand ? ["-e", `GSTACK_COMMAND=${input.gstackCommand}`] : [];
  const gstackArgs = input.gstackArgs ? ["-e", `GSTACK_ARGS=${input.gstackArgs}`] : [];
  const codexAuthArgs = input.codexAuthFile
    ? ["-v", `${input.codexAuthFile}:/codex-seed/auth.json:ro`, "-e", "CODEX_AUTH_FILE=/codex-seed/auth.json"]
    : [];
  const codexConfigArgs = input.codexConfigFile
    ? ["-v", `${input.codexConfigFile}:/codex-seed/config.toml:ro`, "-e", "CODEX_CONFIG_FILE=/codex-seed/config.toml"]
    : [];
  const codexSkillsArgs = input.codexSkillsDir
    ? ["-v", `${input.codexSkillsDir}:/codex-seed/skills:ro`, "-e", "CODEX_SKILLS_DIR=/codex-seed/skills"]
    : [];
  const gstackSkillSourceArgs = input.gstackSkillSourceDir
    ? ["-v", `${input.gstackSkillSourceDir}:${input.gstackSkillSourceDir}:ro`]
    : [];
  return {
    file: "docker",
    args: [
      "run",
      "--rm",
      "--name",
      runnerContainerName(input.run.runId),
      "--network",
      "bridge",
      "--cpus",
      "2",
      "--memory",
      "4g",
      "-v",
      `${input.workspaceMountSource ?? input.workspacePath}:/work/jobs/${input.job.jobId}`,
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
      ...gstackCommandArgs,
      ...gstackArgs,
      ...codexAuthArgs,
      ...codexConfigArgs,
      ...codexSkillsArgs,
      ...gstackSkillSourceArgs,
      ...authArgs,
      input.runnerImage,
    ],
  };
}

/**
 * Pick the GSTACK_ARGS for a job by executor mode (epic D). An explicit
 * `options.gstackArgs` override wins for every job (back-compat). Otherwise the
 * staged mode uses `gstackStagedArgs` and everything else uses `gstackSingleArgs`;
 * either may be undefined, in which case the runner image's own default applies.
 */
export function resolveGstackArgs(
  executorMode: ExecutorInput["executorMode"],
  options: Pick<GstackExecutorOptions, "gstackArgs" | "gstackStagedArgs" | "gstackSingleArgs">,
): string | undefined {
  if (options.gstackArgs !== undefined) return options.gstackArgs;
  return executorMode === "staged" ? options.gstackStagedArgs : options.gstackSingleArgs;
}

export async function executeGstack(input: ExecutorInput, options: GstackExecutorOptions): Promise<AgentResult> {
  // EFFECTIVE timeout for this job: prefer the per-job value resolved from env ⊕ DB
  // override (Settings page) so a live override applies without a restart; fall back
  // to the executor's startup-configured timeout.
  const effectiveTimeoutSeconds = input.jobTimeoutSeconds ?? options.timeoutSeconds;
  const repositoryUrl = toRepositoryUrl(input.job.repository);
  const trustedBaseSha = await resolveRemoteTargetSha(repositoryUrl, input.job.targetBranch, options.githubToken);
  const workspaceMountSource = mapWorkspacePathForDockerMount(
    input.run.workspacePath,
    options.workspaceRoot,
    options.workspaceHostRoot,
  );
  const command = buildGstackDockerCommand({
    runnerImage: options.runnerImage,
    workspacePath: input.run.workspacePath,
    workspaceMountSource,
    gstackCommand: options.gstackCommand,
    gstackArgs: resolveGstackArgs(input.executorMode, options),
    codexAuthFile: options.codexAuthFile,
    codexConfigFile: options.codexConfigFile,
    codexSkillsDir: options.codexSkillsDir,
    gstackSkillSourceDir: options.gstackSkillSourceDir,
    job: input.job,
    run: input.run,
    timeoutSeconds: effectiveTimeoutSeconds,
    githubToken: options.githubToken,
  });

  await writeRunnerInputArtifacts({
    workspacePath: input.run.workspacePath,
    job: input.job,
    run: input.run,
    policy: options.policy ?? { repositoryAllowlist: [], protectedPathDenylist: [] },
    // X4: thread operator retry-guidance into the runner input context so the agent
    // reads the steering alongside the ticket. Undefined when there is none.
    retryGuidance: input.retryGuidance,
  });
  await runCommand(command, input, ((effectiveTimeoutSeconds ?? 3600) + 30) * 1000, 2000, {
    signal: input.signal,
    containerName: runnerContainerName(input.run.runId),
  });

  const resultPath = options.resultPath ?? getWorkspacePaths(input.run.workspacePath).resultJson;
  const result = parseAgentResult(JSON.parse(await readFile(resultPath, "utf8")) as unknown);
  if (result.status !== "completed") return result;

  const trustedEvidence = await collectTrustedGitEvidence(
    getWorkspacePaths(input.run.workspacePath).repoDir,
    input.job.targetBranch,
    trustedBaseSha,
  );
  return applyTrustedGitEvidence(result, trustedEvidence);
}

export function mapWorkspacePathForDockerMount(
  workspacePath: string,
  workspaceRoot?: string,
  workspaceHostRoot?: string,
): string {
  if (!workspaceHostRoot) return workspacePath;
  const resolvedWorkspaceRoot = resolve(workspaceRoot ?? "/tmp/ticket-to-pr-worker");
  const resolvedWorkspacePath = resolve(workspacePath);
  const relativeWorkspacePath = relative(resolvedWorkspaceRoot, resolvedWorkspacePath);

  if (relativeWorkspacePath.startsWith("..") || isAbsolute(relativeWorkspacePath)) {
    throw new Error("Runner workspace path must stay inside the worker workspace root");
  }

  return join(workspaceHostRoot, relativeWorkspacePath);
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
    commits: evidence.commits,
  });
}

export async function resolveRemoteTargetSha(
  repositoryUrl: string,
  targetBranch: string,
  githubToken?: string,
): Promise<string> {
  const stdout = (await runGit(["ls-remote", "--heads", repositoryUrl, targetBranch], undefined, githubToken)).stdout;
  const [sha] = stdout.trim().split(/\s+/);
  if (!sha) throw new Error(`Unable to resolve remote target branch ${targetBranch}`);
  return sha;
}

export async function collectTrustedGitEvidence(
  repoDir: string,
  targetBranch: string,
  baseSha: string,
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
  /** X4 operator retry-guidance, written into context.json + a guidance markdown file. */
  retryGuidance?: string | undefined;
}): Promise<void> {
  const paths = getWorkspacePaths(input.workspacePath);
  const guidance = input.retryGuidance?.trim();
  await mkdir(paths.inputDir, { recursive: true });
  await writeFile(paths.ticketMd, renderTicketMarkdown(input.job, guidance));
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
        workBranch: input.run.workBranch,
        // Present only on a retry-with-guidance attempt (X4). Forward-compatible:
        // the runner may read it or ignore it.
        ...(guidance ? { retryGuidance: guidance } : {}),
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(paths.policyJson, `${JSON.stringify(input.policy, null, 2)}\n`);
  // Also drop a human/agent-readable steering file next to the ticket so a runner
  // that only reads markdown still picks up the guidance.
  if (guidance) {
    await writeFile(join(paths.inputDir, "retry-guidance.md"), `# Operator Retry Guidance\n\n${guidance}\n`);
  }
}

export function maskExecutorOutput(text: string): { text: string; redactionApplied: boolean } {
  const masked = maskSecrets(text);
  return { text: masked, redactionApplied: masked !== text || masked.includes("[REDACTED_") };
}

function renderTicketMarkdown(
  job: {
    title: string;
    description: string;
    definitionOfDone: string;
    repository: string;
    targetBranch: string;
  },
  retryGuidance?: string,
): string {
  const lines = [
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
    "",
  ];
  if (retryGuidance) {
    // X4: surface operator steering directly in the ticket the agent reads.
    lines.push("## Operator Retry Guidance", retryGuidance, "");
  }
  return lines.join("\n");
}

function toRepositoryUrl(repository: string): string {
  if (/^(https?:\/\/|git@)/.test(repository)) return repository;
  return `https://github.com/${repository}.git`;
}

// Deterministic, docker-safe container name so a cancel can target the running runner.
export function runnerContainerName(runId: string): string {
  return `ticket-to-pr-${runId}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

export async function runCommand(
  command: CommandSpec,
  input: ExecutorInput,
  timeoutMs = 3_630_000,
  killGraceMs = 2000,
  options: { signal?: AbortSignal | undefined; containerName?: string } = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.file, command.args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdoutSequence = 0;
    let stderrSequence = 0;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let killTimeout: NodeJS.Timeout | undefined;
    const pendingLogs: Promise<void>[] = [];
    const stdoutRedactor = createSecretRedactor();
    const stderrRedactor = createSecretRedactor();

    const appendLog = (log: Parameters<NonNullable<ExecutorInput["appendLog"]>>[0]) => {
      if (input.appendLog) pendingLogs.push(input.appendLog(log));
    };

    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      clearRunCommandTimers(timeout, killTimeout);
      reject(error);
    };

    // Cancel: stop the named container (so the attached `docker run` exits) and the client.
    const onAbort = () => {
      aborted = true;
      if (options.containerName) {
        try {
          spawn("docker", ["kill", options.containerName], { stdio: "ignore" }).on("error", () => undefined);
        } catch {
          // best effort
        }
      }
      terminateProcessGroup(child, "SIGTERM");
      killTimeout = setTimeout(() => terminateProcessGroup(child, "SIGKILL"), killGraceMs);
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessGroup(child, "SIGTERM");
      killTimeout = setTimeout(() => {
        terminateProcessGroup(child, "SIGKILL");
      }, killGraceMs);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      const masked = maskExecutorOutput(stdoutRedactor(chunk.toString("utf8")));
      appendLog({ source: "gstack", stream: "stdout", sequence: stdoutSequence++, ...masked });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const masked = maskExecutorOutput(stderrRedactor(chunk.toString("utf8")));
      appendLog({ source: "gstack", stream: "stderr", sequence: stderrSequence++, ...masked });
    });
    child.on("error", (error) => settleReject(error));
    child.on("close", async (code) => {
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      clearRunCommandTimers(timeout, killTimeout);
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
        settleReject(rejectedLog.reason instanceof Error ? rejectedLog.reason : new Error(String(rejectedLog.reason)));
        return;
      }
      if (aborted) {
        settleReject(new Error("gstack runner cancelled"));
        return;
      }
      if (timedOut) {
        settleReject(new Error(`gstack runner timed out after ${timeoutMs}ms`));
        return;
      }
      if (code === 0) {
        if (settled) return;
        settled = true;
        resolve();
        return;
      }
      settleReject(new Error(`gstack runner exited with code ${code ?? "unknown"}`));
    });
  });
}

function clearRunCommandTimers(timeout: NodeJS.Timeout | undefined, killTimeout: NodeJS.Timeout | undefined): void {
  if (timeout !== undefined) clearTimeout(timeout);
  if (killTimeout !== undefined) clearTimeout(killTimeout);
}

function terminateProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function runGit(args: string[], cwd?: string, githubToken?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", buildSafeGitArgs(args, cwd), {
      cwd,
      env: githubToken ? buildGitAuthEnv(process.env, githubToken) : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
      reject(
        new Error(`git ${args.join(" ")} failed with code ${code ?? "unknown"}: ${maskSecrets(stderr || stdout)}`),
      );
    });
  });
}

function buildGitAuthEnv(source: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    ...source,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${encoded}`,
  };
}
