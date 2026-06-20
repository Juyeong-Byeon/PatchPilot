import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getWorkspacePaths } from "@ticket-to-pr/runner-contract";
import {
  commitDirtyWorktreeIfNeeded,
  defaultCodexArgs,
  ensureGitIdentity,
  gitStdout,
  prepareCodexHome,
  runCodexCommand,
  writeResultArtifacts,
  type RunnerContext,
} from "./codex-agent-runner.js";

export interface GstackStagedRunnerInput {
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

interface StagePromptContext {
  ticket: string;
  targetBranch: string;
  outputDir: string;
}

interface StageDefinition {
  key: string;
  /** Markdown heading + output file used to fold this stage's notes into the PR body. */
  outputFile?: string;
  heading?: string;
  buildPrompt(ctx: StagePromptContext): string;
}

const COMMON_RULES = [
  "Hard rules for every stage:",
  "- Stay strictly scoped to the ticket; do not refactor unrelated code.",
  "- Do NOT push branches, open pull requests, edit git remotes, or touch files outside the repository.",
  "- Keep secrets out of logs and artifacts.",
  "- Stage note files live OUTSIDE the repository (under the output directory); never `git add` them.",
].join("\n");

// Sequential gstack pipeline. Each stage is a separate non-interactive Codex pass
// scoped to a specific gstack skill (except implement, which is plain coding driven
// by the plan). Stages share the repo working tree and thread notes via output/.
const STAGES: StageDefinition[] = [
  {
    key: "plan",
    outputFile: "plan.md",
    heading: "## Implementation plan (gstack-autoplan)",
    buildPrompt: (ctx) =>
      [
        "You are STAGE 1 of 4 (PLAN) in the Ticket-to-PR gstack pipeline, running non-interactively in an isolated runner container.",
        "Use the `gstack-autoplan` skill from your skills directory (run its preamble first).",
        "- Read input/ticket.md, input/context.json, and input/policy.json.",
        "- Produce a concise, actionable implementation plan for ONLY this ticket.",
        `- WRITE the plan to the absolute path ${path.join(ctx.outputDir, "plan.md")} (outside the repo; do not commit it).`,
        "- Do NOT modify repository code in this stage.",
        "",
        COMMON_RULES,
        "",
        "Ticket:",
        ctx.ticket,
      ].join("\n"),
  },
  {
    key: "implement",
    buildPrompt: (ctx) =>
      [
        "You are STAGE 2 of 4 (IMPLEMENT) in the Ticket-to-PR gstack pipeline.",
        `Read input/ticket.md and the plan at ${path.join(ctx.outputDir, "plan.md")}.`,
        "- Implement ONLY the ticket request in this repository, following the plan with minimal, focused changes.",
        "- Apply gstack engineering discipline: small steps, verify as you go.",
        "- Create at least one local git commit on the current branch.",
        "",
        COMMON_RULES,
        "",
        "Ticket:",
        ctx.ticket,
      ].join("\n"),
  },
  {
    key: "review",
    outputFile: "review.md",
    heading: "## Review (gstack-review)",
    buildPrompt: (ctx) =>
      [
        "You are STAGE 3 of 4 (REVIEW) in the Ticket-to-PR gstack pipeline.",
        "Use the `gstack-review` skill from your skills directory (run its preamble first).",
        `- Review the diff against ${ctx.targetBranch} for correctness, trust-boundary violations, conditional side effects, and structural issues, relative to input/ticket.md and the plan.`,
        `- WRITE your findings to the absolute path ${path.join(ctx.outputDir, "review.md")} (outside the repo; do not commit it).`,
        "- If you find blocking issues, fix them in the repository and commit the fixes.",
        "",
        COMMON_RULES,
      ].join("\n"),
  },
  {
    key: "qa",
    outputFile: "qa.md",
    heading: "## Verification (gstack qa)",
    buildPrompt: (ctx) =>
      [
        "You are STAGE 4 of 4 (VERIFY) in the Ticket-to-PR gstack pipeline.",
        "- Detect and run the project's automated checks relevant to the change (e.g. tests, lint, build) and summarize the results.",
        "- If the change is a runnable web application and a dev server is trivially available, you MAY use the `gstack-qa` skill to exercise it.",
        `- WRITE a verification summary to the absolute path ${path.join(ctx.outputDir, "qa.md")} (outside the repo; do not commit it).`,
        "- Commit any fixes you make as part of verification.",
        "",
        COMMON_RULES,
      ].join("\n"),
  },
];

export async function runGstackStagedRunner(input: GstackStagedRunnerInput): Promise<void> {
  const paths = getWorkspacePaths(input.workspaceRoot);
  await mkdir(paths.outputDir, { recursive: true });
  const context = JSON.parse(await readFile(paths.contextJson, "utf8")) as RunnerContext;
  const ticket = await readFile(paths.ticketMd, "utf8");
  const baseSha = await gitStdout(["rev-parse", "HEAD"], input.repoDir);

  const codexHome = await prepareCodexHome({
    codexHome: input.codexHome ?? path.join(tmpdir(), `ticket-to-pr-gstack-${context.runId}`),
    codexAuthFile: input.codexAuthFile ?? process.env.CODEX_AUTH_FILE,
    codexConfigFile: input.codexConfigFile ?? process.env.CODEX_CONFIG_FILE,
    codexSkillsDir: input.codexSkillsDir ?? process.env.CODEX_SKILLS_DIR,
  });
  await ensureGitIdentity(input.repoDir);

  const command = input.codexCommand ?? process.env.CODEX_COMMAND ?? "codex";
  const args = input.codexArgs ?? defaultCodexArgs(input.repoDir);
  const promptContext: StagePromptContext = {
    ticket,
    targetBranch: input.targetBranch,
    outputDir: paths.outputDir,
  };

  for (let index = 0; index < STAGES.length; index += 1) {
    const stage = STAGES[index];
    console.log(`\n=== gstack stage ${index + 1}/${STAGES.length}: ${stage.key} ===`);
    try {
      await runCodexCommand({
        repoDir: input.repoDir,
        codexHome,
        command,
        args,
        prompt: stage.buildPrompt(promptContext),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`gstack stage "${stage.key}" failed: ${message}`);
    }
  }

  // Safety net: the implement/review stages must have produced commits or at least
  // dirty changes; this commits any uncommitted work and fails if nothing changed.
  await commitDirtyWorktreeIfNeeded(input.repoDir, baseSha);

  const prBodySections = await collectStageSections(paths.outputDir);
  await writeResultArtifacts({
    workspaceRoot: input.workspaceRoot,
    repoDir: input.repoDir,
    targetBranch: input.targetBranch,
    baseSha,
    context,
    reviewSummary: "Implemented through the gstack staged pipeline: plan -> implement -> review -> verify.",
    prBodySections,
  });
}

async function collectStageSections(outputDir: string): Promise<string[]> {
  const sections: string[] = [];
  for (const stage of STAGES) {
    if (!stage.outputFile || !stage.heading) continue;
    const content = await readFile(path.join(outputDir, stage.outputFile), "utf8").catch(() => "");
    const trimmed = content.trim();
    if (trimmed) sections.push(`${stage.heading}\n\n${trimmed}`);
  }
  return sections;
}

const mainPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (mainPath === fileURLToPath(import.meta.url)) {
  const workspaceRoot = readRequiredEnv("WORKSPACE_ROOT");
  runGstackStagedRunner({
    workspaceRoot,
    repoDir: getWorkspacePaths(workspaceRoot).repoDir,
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
