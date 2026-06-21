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

export interface RunnerContext {
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
    codexSkillsDir: input.codexSkillsDir ?? process.env.CODEX_SKILLS_DIR,
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
      outputDir: paths.outputDir,
    }),
  });

  await commitDirtyWorktreeIfNeeded(input.repoDir, baseSha);
  await writeResultArtifacts({
    workspaceRoot: input.workspaceRoot,
    repoDir: input.repoDir,
    targetBranch: input.targetBranch,
    baseSha,
    context,
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
      verbatimSymlinks: false,
    });
  }
  return input.codexHome;
}

export function defaultCodexArgs(repoDir: string): string[] {
  return ["exec", "--ephemeral", "--sandbox", "danger-full-access", "--skip-git-repo-check", "--cd", repoDir, "-"];
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
    ticket,
  ].join("\n");
}

export function runCodexCommand(input: {
  repoDir: string;
  codexHome: string;
  command: string;
  args: string[];
  prompt: string;
  /** Per-invocation wall-clock budget. The outer runner timeout is the hard backstop. */
  timeoutMs?: number;
  killGraceMs?: number;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.repoDir,
      env: { ...process.env, CODEX_HOME: input.codexHome },
      stdio: ["pipe", "inherit", "inherit"],
    });
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const clearTimers = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };
    if (input.timeoutMs && input.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), input.killGraceMs ?? 2000);
      }, input.timeoutMs);
    }
    child.stdin.end(input.prompt);
    child.on("error", (error) => {
      clearTimers();
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimers();
      if (timedOut) {
        reject(new Error(`codex runner timed out after ${input.timeoutMs}ms`));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`codex runner exited with code ${code ?? "null"}${signal ? ` signal ${signal}` : ""}`));
    });
  });
}

export async function ensureGitIdentity(repoDir: string): Promise<void> {
  await runGit(["config", "user.name", "Ticket-to-PR Codex"], repoDir);
  await runGit(["config", "user.email", "ticket-to-pr-codex@example.local"], repoDir);
}

export async function commitDirtyWorktreeIfNeeded(repoDir: string, baseSha: string): Promise<void> {
  const commitCount = Number(await gitStdout(["rev-list", "--count", `${baseSha}..HEAD`], repoDir));
  if (commitCount > 0) return;

  const dirtyStatus = await gitStdout(["status", "--porcelain"], repoDir);
  if (!dirtyStatus.trim()) {
    throw new Error("Codex completed without creating a local commit or file changes");
  }

  await runGit(["add", "-A"], repoDir);
  await runGit(["commit", "-m", "chore: implement ticket with Codex"], repoDir);
}

export async function writeResultArtifacts(input: {
  workspaceRoot: string;
  repoDir: string;
  targetBranch: string;
  baseSha: string;
  context: RunnerContext;
  /** Overrides the default review summary recorded in result.json. */
  reviewSummary?: string;
  /** Extra markdown sections appended to pr-body.md (e.g. staged plan/review/qa output). */
  prBodySections?: string[];
  /** Real verification results to record in result.json (gated by the policy gate). */
  tests?: Array<{ command: string; status: "passed" | "failed" | "skipped"; summary?: string }>;
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
    // Honest default: the single-pass runner does NOT run project verification, so it must
    // not claim a passing test. `skipped` is truthful; the platform/policy layer surfaces it
    // as "no verification". Staged runs pass a real `tests` result derived from qa.json.
    tests: input.tests ?? [
      {
        command: "project verification",
        status: "skipped",
        summary: "Single-pass runner did not run project verification.",
      },
    ],
    review: {
      summary:
        input.reviewSummary ?? "Codex CLI completed the requested ticket change in an isolated runner workspace.",
      risks: [],
      knownLimitations: ["The runner adapter generated PR metadata from trusted git evidence after Codex exited."],
    },
    pullRequestDraft: {
      title,
      bodyPath: "output/pr-body.md",
    },
    failure: null,
    retryable: false,
  });

  const body = composePrBody({ changedFiles, prBodySections: input.prBodySections });
  await writeTextArtifact(paths.prTitle, `${title}\n`);
  await writeTextArtifact(paths.prBody, body);
  await writeJsonArtifact(paths.resultJson, result);
}

/**
 * Builds the reviewer-facing PR body from agent-authored content only.
 *
 * The platform trust footer (audited SHAs, policy verdict, tests) is appended later by the
 * publisher/worker track — this builder deliberately does NOT emit it, and must never emit a
 * fabricated verification line (the legacy `## Verification\n- git diff --name-only` block
 * falsely contradicted the real `npm run ci` evidence in staged PR bodies).
 *
 * - Staged runs supply rich `prBodySections` (agent-authored description + stage notes); the
 *   body is exactly those sections, with no platform-injected preamble.
 * - Single-pass has no rich sections yet, so we emit a minimal, honest `## Summary` listing the
 *   changed files — and nothing claiming verification ran.
 */
export function composePrBody(input: { changedFiles: string[]; prBodySections?: string[] }): string {
  const sections = (input.prBodySections ?? []).filter((section) => section.trim().length > 0);
  if (sections.length > 0) {
    return sections.join("\n\n");
  }
  return [
    "## Summary",
    "- Implemented by Codex CLI through the Ticket-to-PR runner.",
    `- Changed files: ${input.changedFiles.join(", ")}`,
  ].join("\n");
}

export async function gitStdout(args: string[], cwd: string): Promise<string> {
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
    targetBranch: readRequiredEnv("TARGET_BRANCH"),
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
