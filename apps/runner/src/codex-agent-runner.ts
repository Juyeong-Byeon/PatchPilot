import { spawn } from "node:child_process";
import { copyFile, cp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAgentResult } from "@ticket-to-pr/core";
import { getWorkspacePaths, writeJsonArtifact, writeTextArtifact } from "@ticket-to-pr/runner-contract";

export interface CodexAgentRunnerInput {
  workspaceRoot: string;
  repoDir: string;
  targetBranch: string;
  codexCommand?: string;
  codexArgs?: string[];
  codexHome?: string;
  codexAuthFile?: string;
  codexConfigFile?: string;
  codexSkillsDir?: string;
}

interface RunnerContext {
  jobId: string;
  ticketSnapshotId: string;
  triggerVersion: string;
  runId: string;
  attempt: number;
  workBranch: string;
}

export async function runCodexAgentRunner(input: CodexAgentRunnerInput): Promise<void> {
  const paths = getWorkspacePaths(input.workspaceRoot);
  const context = JSON.parse(await readFile(paths.contextJson, "utf8")) as RunnerContext;
  const baseSha = await gitStdout(["rev-parse", "HEAD"], input.repoDir);
  const codexHome = await prepareCodexHome({
    codexHome: input.codexHome ?? path.join(tmpdir(), `ticket-to-pr-codex-${context.runId}`),
    codexAuthFile: input.codexAuthFile ?? process.env.CODEX_AUTH_FILE,
    codexConfigFile: input.codexConfigFile ?? process.env.CODEX_CONFIG_FILE,
    codexSkillsDir: input.codexSkillsDir ?? process.env.CODEX_SKILLS_DIR
  });

  await ensureGitIdentity(input.repoDir);
  await runCodexCommand({
    repoDir: input.repoDir,
    codexHome,
    command: input.codexCommand ?? process.env.CODEX_COMMAND ?? "codex",
    args: input.codexArgs ?? defaultCodexArgs(input.repoDir),
    prompt: await buildCodexPrompt({
      workspaceRoot: input.workspaceRoot,
      repoDir: input.repoDir,
      ticketPath: paths.ticketMd,
      contextPath: paths.contextJson,
      policyPath: paths.policyJson,
      outputDir: paths.outputDir
    })
  });

  await commitDirtyWorktreeIfNeeded(input.repoDir, baseSha);
  await writeResultArtifacts({
    workspaceRoot: input.workspaceRoot,
    repoDir: input.repoDir,
    targetBranch: input.targetBranch,
    baseSha,
    context
  });
}

export async function prepareCodexHome(input: {
  codexHome: string;
  codexAuthFile?: string;
  codexConfigFile?: string;
  codexSkillsDir?: string;
}): Promise<string> {
  await mkdir(input.codexHome, { recursive: true });
  if (input.codexAuthFile) {
    await copyFile(input.codexAuthFile, path.join(input.codexHome, "auth.json"));
  }
  if (input.codexConfigFile) {
    await copyFile(input.codexConfigFile, path.join(input.codexHome, "config.toml"));
  }
  if (input.codexSkillsDir) {
    await cp(input.codexSkillsDir, path.join(input.codexHome, "skills"), {
      recursive: true,
      dereference: true,
      force: true,
      verbatimSymlinks: false
    });
  }
  return input.codexHome;
}

function defaultCodexArgs(repoDir: string): string[] {
  return [
    "exec",
    "--ephemeral",
    "--sandbox",
    "danger-full-access",
    "--skip-git-repo-check",
    "--cd",
    repoDir,
    "-"
  ];
}

async function buildCodexPrompt(input: {
  workspaceRoot: string;
  repoDir: string;
  ticketPath: string;
  contextPath: string;
  policyPath: string;
  outputDir: string;
}): Promise<string> {
  const ticket = await readFile(input.ticketPath, "utf8");
  return [
    "You are the Ticket-to-PR implementation agent running inside an isolated runner container.",
    "",
    "Use Codex non-interactively to implement the requested change. If gstack skills are available, use their engineering discipline for implementation and review, but keep the task tightly scoped.",
    "",
    "Hard requirements:",
    "- Read `input/ticket.md`, `input/context.json`, and `input/policy.json` before editing.",
    "- Implement only the ticket request in the current repository.",
    "- Do not push branches, create pull requests, edit remotes, or modify files outside the repository.",
    "- Keep secrets out of logs and artifacts.",
    "- Run lightweight verification appropriate for the change.",
    "- Create at least one local git commit on the current branch.",
    "",
    "The runner adapter will create result.json, pr-title.txt, and pr-body.md from trusted git evidence after you exit.",
    "",
    `Workspace root: ${input.workspaceRoot}`,
    `Repository directory: ${input.repoDir}`,
    `Ticket path: ${input.ticketPath}`,
    `Context path: ${input.contextPath}`,
    `Policy path: ${input.policyPath}`,
    `Output directory: ${input.outputDir}`,
    "",
    "Ticket:",
    ticket
  ].join("\n");
}

function runCodexCommand(input: {
  repoDir: string;
  codexHome: string;
  command: string;
  args: string[];
  prompt: string;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.repoDir,
      env: { ...process.env, CODEX_HOME: input.codexHome },
      stdio: ["pipe", "inherit", "inherit"]
    });
    child.stdin.end(input.prompt);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`codex runner exited with code ${code ?? "null"}${signal ? ` signal ${signal}` : ""}`));
    });
  });
}

async function ensureGitIdentity(repoDir: string): Promise<void> {
  await runGit(["config", "user.name", "Ticket-to-PR Codex"], repoDir);
  await runGit(["config", "user.email", "ticket-to-pr-codex@example.local"], repoDir);
}

async function commitDirtyWorktreeIfNeeded(repoDir: string, baseSha: string): Promise<void> {
  const commitCount = Number(await gitStdout(["rev-list", "--count", `${baseSha}..HEAD`], repoDir));
  if (commitCount > 0) return;

  const dirtyStatus = await gitStdout(["status", "--porcelain"], repoDir);
  if (!dirtyStatus.trim()) {
    throw new Error("Codex completed without creating a local commit or file changes");
  }

  await runGit(["add", "-A"], repoDir);
  await runGit(["commit", "-m", "chore: implement ticket with Codex"], repoDir);
}

async function writeResultArtifacts(input: {
  workspaceRoot: string;
  repoDir: string;
  targetBranch: string;
  baseSha: string;
  context: RunnerContext;
}): Promise<void> {
  const paths = getWorkspacePaths(input.workspaceRoot);
  const headSha = await gitStdout(["rev-parse", "HEAD"], input.repoDir);
  const changedFiles = (await gitStdout(["diff", "--name-only", `${input.baseSha}...${headSha}`], input.repoDir))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (changedFiles.length === 0) {
    throw new Error("Codex completed without changed files");
  }

  const commits = (await gitStdout(["log", "--format=%H%x00%s", `${input.baseSha}..${headSha}`], input.repoDir))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, ...messageParts] = line.split("\0");
      return { sha: sha ?? "", message: messageParts.join("\0") || "Codex implementation" };
    });
  const title = commits[0]?.message ?? "chore: implement ticket with Codex";
  const result = parseAgentResult({
    schemaVersion: "1.0",
    runId: input.context.runId,
    jobId: input.context.jobId,
    ticketId: input.context.ticketSnapshotId,
    triggerVersion: input.context.triggerVersion,
    status: "completed",
    targetBranch: input.targetBranch,
    baseSha: input.baseSha,
    headSha,
    pushSha: headSha,
    changedFiles,
    commits,
    tests: [
      {
        command: "git diff --name-only",
        status: "passed",
        summary: changedFiles.join(", ")
      }
    ],
    review: {
      summary: "Codex CLI completed the requested ticket change in an isolated runner workspace.",
      risks: [],
      knownLimitations: ["The runner adapter generated PR metadata from trusted git evidence after Codex exited."]
    },
    pullRequestDraft: {
      title,
      bodyPath: "output/pr-body.md"
    },
    failure: null,
    retryable: false
  });

  await writeTextArtifact(paths.prTitle, `${title}\n`);
  await writeTextArtifact(
    paths.prBody,
    [
      "## Summary",
      "- Implemented by Codex CLI through the Ticket-to-PR runner.",
      `- Changed files: ${changedFiles.join(", ")}`,
      "",
      "## Verification",
      "- git diff --name-only"
    ].join("\n")
  );
  await writeJsonArtifact(paths.resultJson, result);
}

async function gitStdout(args: string[], cwd: string): Promise<string> {
  return (await runGit(args, cwd)).stdout.trim();
}

function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
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
      reject(new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`));
    });
  });
}

const mainPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (mainPath === fileURLToPath(import.meta.url)) {
  runCodexAgentRunner({
    workspaceRoot: readRequiredEnv("WORKSPACE_ROOT"),
    repoDir: getWorkspacePaths(readRequiredEnv("WORKSPACE_ROOT")).repoDir,
    targetBranch: readRequiredEnv("TARGET_BRANCH")
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}
