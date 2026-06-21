import { spawn } from "node:child_process";
import { copyFile, cp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAgentResult } from "@ticket-to-pr/core";
import {
  getWorkspacePaths,
  parseRunnerContext,
  type RunnerContext,
  writeJsonArtifact,
  writeTextArtifact,
} from "@ticket-to-pr/runner-contract";

/**
 * Structured agent-failure report the agent (or a stage) may drop at
 * `output/failure.json` when it cannot complete the ticket. The runner turns it
 * into a schema-valid `result.json` with `status: "failed"` so the worker can
 * surface "what went wrong + what to do next" instead of an opaque crash.
 *
 * `retryable` is optional: when omitted the runner derives it from `category`
 * (infrastructure/internal problems are retryable; agent/policy problems are
 * actionable and are not auto-retried).
 */
export interface StructuredAgentFailure {
  stage: string;
  category: string;
  message: string;
  nextAction: string;
  retryable?: boolean;
}

/**
 * Agent-authored "I am blocked on a human decision" report dropped at
 * `output/needs-input.json` when the only way forward is a clarification the
 * agent cannot invent (ambiguous requirement / missing decision). The runner
 * turns it into a schema-valid `result.json` with `status: "needs_input"` so the
 * worker PARKS the job (no PR, no failure) and surfaces the question to the
 * operator. PRECEDENCE: a valid needs-input.json wins over failure.json — asking
 * the human is strictly better than failing when both files are present.
 */
export interface AgentNeedsInput {
  question: string;
  details?: string;
}

const FAILURE_FILE = "failure.json";
const NEEDS_INPUT_FILE = "needs-input.json";
// Categories that describe an environment/transport problem the platform can retry
// as-is. Everything else (agent quality, policy) needs a human to change the input.
const RETRYABLE_FAILURE_CATEGORIES = new Set(["infra", "infrastructure", "internal", "transient", "timeout"]);

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

// `RunnerContext` is validated at the `context.json` boundary by
// `parseRunnerContext`; re-exported here so existing importers (e.g.
// gstack-staged-runner) keep a single source of truth for the type.
export type { RunnerContext };

export async function runCodexAgentRunner(input: CodexAgentRunnerInput): Promise<void> {
  const paths = getWorkspacePaths(input.workspaceRoot);
  await mkdir(paths.outputDir, { recursive: true });
  const context = parseRunnerContext(await readFile(paths.contextJson, "utf8"));
  await runWithStructuredFailure(input.workspaceRoot, async () => {
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
    await maybeRunSelfReview({ ...input, paths, codexHome });
    await writeResultArtifacts({
      workspaceRoot: input.workspaceRoot,
      repoDir: input.repoDir,
      targetBranch: input.targetBranch,
      baseSha,
      context,
      tests: await readSelfReviewTests(paths.outputDir),
    });
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
    "If you are genuinely BLOCKED on a decision only a human can make — an ambiguous or contradictory requirement,",
    "a missing product/design decision, two equally valid interpretations you cannot choose between — do NOT guess,",
    `fabricate, or hard-fail. Instead WRITE ${path.join(input.outputDir, "needs-input.json")} as JSON:`,
    '{"question":"<ONE specific, answerable question>","details":"<optional: the options you are weighing>"}',
    "and make/push NOTHING. The runner parks the job and the operator answers; their answer seeds your next run.",
    "Reserve this for TRUE blockers — not routine implementation choices you can reasonably make yourself.",
    "",
    "If instead you genuinely cannot complete the ticket for a NON-question reason (missing dependency,",
    `blocked by the environment, contradictory rules), do NOT fake a change. Instead WRITE ${path.join(input.outputDir, "failure.json")}`,
    'as JSON: {"stage":"implement","category":"agent","message":"<what blocked you>","nextAction":"<what a human should change>"}',
    "(category: agent = needs a clearer ticket; infra = environment/transport problem; policy = blocked by rules).",
    "The runner turns that file into a structured, actionable failure instead of an opaque crash.",
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

/**
 * Opt-in (default OFF) lightweight self-review/verify pass for the single-pass
 * runner. Enabled with `CODEX_SELF_REVIEW=1`. It is NOT the full 4× staged
 * pipeline: it adds exactly one extra Codex pass that re-reads its own diff,
 * runs the project's quick checks if any, and writes:
 *   - `output/self-review.md`  (human-readable, folded into the PR body), and
 *   - `output/qa.json`         ({passed,command,summary}; gates the run + tests).
 * Any review fixes the pass makes are committed. Default behavior (flag unset)
 * is unchanged: no extra pass, `tests` stays honestly `skipped`.
 */
export async function maybeRunSelfReview(input: {
  repoDir: string;
  workspaceRoot: string;
  targetBranch: string;
  codexCommand?: string;
  codexArgs?: string[];
  codexHome: string;
  paths: { outputDir: string };
}): Promise<void> {
  if (!isSelfReviewEnabled()) return;
  const baseSha = await gitStdout(["rev-parse", "HEAD"], input.repoDir);
  console.log("\nSingle-pass self-review enabled (CODEX_SELF_REVIEW): running one verify/review pass.");
  await runCodexCommand({
    repoDir: input.repoDir,
    codexHome: input.codexHome,
    command: input.codexCommand ?? process.env.CODEX_COMMAND ?? "codex",
    args: input.codexArgs ?? defaultCodexArgs(input.repoDir),
    prompt: [
      "You are the SELF-REVIEW pass of the single-pass Ticket-to-PR runner.",
      `Inspect the change you just made by running: git --no-pager diff ${input.targetBranch}...HEAD (run it; do not guess).`,
      "Step 1: review that diff for correctness, scope creep, and obvious defects relative to the ticket; fix and commit any blocking issues you find.",
      "Step 2: detect and run the project's quick automated checks (tests, then lint/build if cheap). Commit any fixes.",
      `Step 3: WRITE a machine-readable result to ${path.join(input.paths.outputDir, "qa.json")} as JSON: {"passed": <true|false>, "command": "<main check you ran>", "summary": "<short result>"}. Set passed=true only if the checks actually succeeded; if the repo has no runnable checks, passed=true with a summary saying so.`,
      `Step 4: WRITE a short human-readable summary to ${path.join(input.paths.outputDir, "self-review.md")}.`,
      "Do NOT push, open PRs, edit remotes, or touch files outside the repository. Keep secrets out of logs and artifacts.",
    ].join("\n"),
  });
  await commitDirtyWorktreeIfNeeded(input.repoDir, baseSha).catch(() => undefined);
  const qa = await readSelfReviewQa(input.paths.outputDir);
  if (qa && qa.passed === false) {
    throw new Error(`single-pass self-review reported failing verification: ${qa.summary ?? "see self-review.md"}`);
  }
}

interface SelfReviewQa {
  passed: boolean;
  command?: string;
  summary?: string;
}

function isSelfReviewEnabled(): boolean {
  const value = (process.env.CODEX_SELF_REVIEW ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

async function readSelfReviewQa(outputDir: string): Promise<SelfReviewQa | null> {
  const raw = await readFile(path.join(outputDir, "qa.json"), "utf8").catch(() => "");
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SelfReviewQa>;
    return { passed: parsed.passed === true, command: parsed.command, summary: parsed.summary };
  } catch {
    return null;
  }
}

/**
 * Real `tests` evidence for result.json when the self-review pass captured a
 * structured qa.json result; otherwise `undefined` so the caller keeps the
 * honest `skipped` default.
 */
async function readSelfReviewTests(
  outputDir: string,
): Promise<Array<{ command: string; status: "passed" | "skipped"; summary?: string }> | undefined> {
  if (!isSelfReviewEnabled()) return undefined;
  const qa = await readSelfReviewQa(outputDir);
  if (!qa) return undefined;
  return [{ command: qa.command ?? "project checks", status: "passed", summary: qa.summary }];
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
 * Reads and validates an agent-authored `output/failure.json`. Returns `null`
 * when the file is absent or malformed (a malformed failure file must NOT mask
 * the real error path — the caller falls back to throwing).
 */
export async function readStructuredFailure(outputDir: string): Promise<StructuredAgentFailure | null> {
  const raw = await readFile(path.join(outputDir, FAILURE_FILE), "utf8").catch(() => "");
  if (!raw.trim()) return null;
  let parsed: Partial<StructuredAgentFailure>;
  try {
    parsed = JSON.parse(raw) as Partial<StructuredAgentFailure>;
  } catch {
    console.warn(`runner: ${FAILURE_FILE} present but not valid JSON; ignoring`);
    return null;
  }
  const stage = typeof parsed.stage === "string" ? parsed.stage.trim() : "";
  const category = typeof parsed.category === "string" ? parsed.category.trim() : "";
  const message = typeof parsed.message === "string" ? parsed.message.trim() : "";
  const nextAction = typeof parsed.nextAction === "string" ? parsed.nextAction.trim() : "";
  if (!stage || !category || !message || !nextAction) {
    console.warn(`runner: ${FAILURE_FILE} missing required fields (stage/category/message/nextAction); ignoring`);
    return null;
  }
  return {
    stage,
    category,
    message,
    nextAction,
    retryable: typeof parsed.retryable === "boolean" ? parsed.retryable : undefined,
  };
}

/**
 * Reads and validates an agent-authored `output/needs-input.json`. Returns
 * `null` when the file is absent or malformed (a malformed file must NOT mask the
 * normal result/failure path — the caller falls back as if it were not present).
 * `details` is optional context; only a non-empty `question` makes the file valid.
 */
export async function readNeedsInput(outputDir: string): Promise<AgentNeedsInput | null> {
  const raw = await readFile(path.join(outputDir, NEEDS_INPUT_FILE), "utf8").catch(() => "");
  if (!raw.trim()) return null;
  let parsed: Partial<AgentNeedsInput>;
  try {
    parsed = JSON.parse(raw) as Partial<AgentNeedsInput>;
  } catch {
    console.warn(`runner: ${NEEDS_INPUT_FILE} present but not valid JSON; ignoring`);
    return null;
  }
  const question = typeof parsed.question === "string" ? parsed.question.trim() : "";
  if (!question) {
    console.warn(`runner: ${NEEDS_INPUT_FILE} missing required field (question); ignoring`);
    return null;
  }
  const details = typeof parsed.details === "string" ? parsed.details.trim() : "";
  return details ? { question, details } : { question };
}

/**
 * Emits a schema-valid `result.json` with `status: "needs_input"`: the run made
 * and pushed NOTHING, it carries only the agent's one blocking question (plus
 * optional details folded into the human-readable body). The worker reads this as
 * a clean PARK (not a failure) and asks the operator to answer.
 */
export async function writeNeedsInputResult(input: {
  workspaceRoot: string;
  context: RunnerContext;
  needsInput: AgentNeedsInput;
}): Promise<void> {
  const paths = getWorkspacePaths(input.workspaceRoot);
  const result = parseAgentResult({
    schemaVersion: "1.0",
    runId: input.context.runId,
    jobId: input.context.jobId,
    ticketId: input.context.ticketSnapshotId,
    triggerVersion: input.context.triggerVersion,
    status: "needs_input",
    question: input.needsInput.question,
    changedFiles: [],
    commits: [],
    tests: [],
    failure: null,
    retryable: false,
  });
  await writeJsonArtifact(paths.resultJson, result);
  await writeTextArtifact(paths.prTitle, `Agent needs operator input\n`);
  await writeTextArtifact(
    paths.prBody,
    [
      "## Agent needs operator input",
      "The agent paused because it hit a decision only a human can make.",
      "",
      `- Question: ${input.needsInput.question}`,
      ...(input.needsInput.details ? [`- Details: ${input.needsInput.details}`] : []),
    ].join("\n"),
  );
}

/**
 * Emits a schema-valid `result.json` with `status: "failed"` and structured
 * failure details, plus a human-readable `pr-body.md`/`pr-title.txt` for parity.
 * The worker reads this as an actionable (or retryable) failure instead of an
 * opaque non-zero exit.
 */
export async function writeFailureResult(input: {
  workspaceRoot: string;
  context: RunnerContext;
  failure: StructuredAgentFailure;
}): Promise<void> {
  const paths = getWorkspacePaths(input.workspaceRoot);
  const retryable = input.failure.retryable ?? RETRYABLE_FAILURE_CATEGORIES.has(input.failure.category.toLowerCase());
  const result = parseAgentResult({
    schemaVersion: "1.0",
    runId: input.context.runId,
    jobId: input.context.jobId,
    ticketId: input.context.ticketSnapshotId,
    triggerVersion: input.context.triggerVersion,
    status: "failed",
    changedFiles: [],
    commits: [],
    tests: [],
    failure: {
      stage: input.failure.stage,
      category: input.failure.category,
      message: input.failure.message,
      nextAction: input.failure.nextAction,
      retryable,
    },
    retryable,
  });
  await writeJsonArtifact(paths.resultJson, result);
  await writeTextArtifact(paths.prTitle, `Ticket could not be completed: ${input.failure.stage}\n`);
  await writeTextArtifact(
    paths.prBody,
    [
      "## Agent could not complete this ticket",
      `- Stage: ${input.failure.stage}`,
      `- Category: ${input.failure.category}`,
      `- What happened: ${input.failure.message}`,
      `- Next action: ${input.failure.nextAction}`,
    ].join("\n"),
  );
}

/**
 * Runs the agent body, then resolves the run's outcome with a fixed precedence:
 *
 *   needs-input.json  >  failure.json  >  (success | rethrow)
 *
 * 1. If the agent wrote a valid `output/needs-input.json`, the run is a clean
 *    PARK regardless of whether the body succeeded or threw: we emit a
 *    `status: "needs_input"` result and DISCARD the body's success/error (the
 *    agent deliberately produced no shippable change). Asking the human always
 *    wins over both a "completed" claim and a failure.
 * 2. Else, if the body threw and the agent wrote a valid `output/failure.json`,
 *    convert the crash into a structured `status: "failed"` result.
 * 3. Else, the body's own result stands (success: it already wrote result.json;
 *    failure with no failure.json: rethrow unchanged).
 */
export async function runWithStructuredFailure(workspaceRoot: string, body: () => Promise<void>): Promise<void> {
  const paths = getWorkspacePaths(workspaceRoot);
  let bodyError: unknown;
  let threw = false;
  try {
    await body();
  } catch (error) {
    bodyError = error;
    threw = true;
  }

  // Precedence (1): a blocking question wins over everything — even a body that
  // otherwise "succeeded" (e.g. a stray commit) or one that threw.
  const needsInput = await readNeedsInput(paths.outputDir);
  if (needsInput) {
    const context = parseRunnerContext(await readFile(paths.contextJson, "utf8"));
    console.warn("runner: agent requested operator input (needs-input.json); emitting result.needs_input (no push)");
    await writeNeedsInputResult({ workspaceRoot, context, needsInput });
    return;
  }

  if (!threw) return;

  // Precedence (2): structured failure converts a crash into an actionable result.
  const failure = await readStructuredFailure(paths.outputDir);
  if (!failure) throw bodyError;
  const context = parseRunnerContext(await readFile(paths.contextJson, "utf8"));
  console.warn(
    `runner: agent reported structured failure (${failure.category}/${failure.stage}); emitting result.failure`,
  );
  await writeFailureResult({ workspaceRoot, context, failure });
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
