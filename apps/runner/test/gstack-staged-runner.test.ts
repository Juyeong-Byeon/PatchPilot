import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAgentResult } from "@ticket-to-pr/core";
import { runGstackStagedRunner } from "../src/gstack-staged-runner.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setupWorkspace(): Promise<{ workspaceRoot: string; repoDir: string; inputDir: string }> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ticket-to-pr-gstack-runner-"));
  tempDirs.push(workspaceRoot);
  const repoDir = join(workspaceRoot, "repo");
  const inputDir = join(workspaceRoot, "input");
  await mkdir(inputDir, { recursive: true });
  await run("git", ["init", repoDir]);
  await run("git", ["config", "user.name", "Test User"], repoDir);
  await run("git", ["config", "user.email", "test@example.com"], repoDir);
  await writeFile(join(repoDir, "README.md"), "# Test repo\n");
  await run("git", ["add", "README.md"], repoDir);
  await run("git", ["commit", "-m", "Initial commit"], repoDir);
  await writeFile(
    join(inputDir, "ticket.md"),
    ["# Add hello note", "", "Append a hello note to README.md."].join("\n"),
  );
  await writeFile(
    join(inputDir, "context.json"),
    JSON.stringify({
      jobId: "job_1",
      ticketSnapshotId: "ts_1",
      triggerVersion: "gstack staged",
      runId: "run_1",
      attempt: 1,
      workBranch: "ticket-to-pr/job_1",
    }),
  );
  await writeFile(join(inputDir, "policy.json"), JSON.stringify({ repositoryAllowlist: ["owner/repo"] }));
  return { workspaceRoot, repoDir, inputDir };
}

// Builds a fake Codex that dispatches per stage. `body` is JS appended inside the
// stage handler (has `repoDir`, `outputDir`, `prompt` in scope).
async function writeFakeCodex(file: string, bodyByStage: Record<string, string>): Promise<void> {
  const branches = Object.entries(bodyByStage)
    .map(([marker, body]) => `if (prompt.includes(${JSON.stringify(marker)})) { ${body} } else`)
    .join(" ");
  await writeFile(
    file,
    [
      "import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      "import path from 'node:path';",
      "let prompt = '';",
      "process.stdin.on('data', (c) => { prompt += c.toString('utf8'); });",
      "process.stdin.on('end', () => {",
      "  const repoDir = process.cwd();",
      "  const outputDir = path.join(repoDir, '..', 'output');",
      "  mkdirSync(outputDir, { recursive: true });",
      "  const commit = (m) => { spawnSync('git', ['add', '-A'], { cwd: repoDir }); spawnSync('git', ['commit', '-m', m], { cwd: repoDir }); };",
      `  ${branches} { process.exit(7); }`,
      "});",
      "",
    ].join("\n"),
  );
}

const PLAN = "writeFileSync(path.join(outputDir, 'plan.md'), '# Plan\\n- Append a hello note to README.md\\n');";
const IMPLEMENT =
  "appendFileSync(path.join(repoDir, 'README.md'), '\\nhello from staged pipeline\\n'); commit('feat: add hello note');";
const REVIEW = "writeFileSync(path.join(outputDir, 'review.md'), '# Review\\n- No blocking issues\\n');";
const VERIFY_PASS =
  "writeFileSync(path.join(outputDir, 'qa.json'), JSON.stringify({ passed: true, command: 'npm test', summary: 'all green' })); writeFileSync(path.join(outputDir, 'qa.md'), '# QA\\n- npm test passed\\n');";
const DOCUMENT =
  "writeFileSync(path.join(outputDir, 'pr-description.md'), '## 아키텍처 변경점\\n- README 변경\\n## 새로 추가된 컴포넌트\\n- 해당 없음 — 신규 컴포넌트 없음\\n## 데이터 플로우\\n- 변경 없음\\n## 실패 시나리오\\n- 없음\\n## 트레이드오프\\n- 없음\\n## 테스트 전략\\n- npm test\\n');";

describe("runGstackStagedRunner", () => {
  it("runs plan -> implement -> review -> verify -> document, gates on qa.json, folds notes + description into the PR body", async () => {
    const { workspaceRoot, repoDir } = await setupWorkspace();
    const fakeCodex = join(workspaceRoot, "fake.mjs");
    await writeFakeCodex(fakeCodex, {
      "STAGE 1 of 5": PLAN,
      "STAGE 2 of 5": IMPLEMENT,
      "STAGE 3 of 5": REVIEW,
      "STAGE 4 of 5": VERIFY_PASS,
      "STAGE 5 of 5": DOCUMENT,
    });

    await runGstackStagedRunner({
      workspaceRoot,
      repoDir,
      targetBranch: "main",
      codexCommand: "node",
      codexArgs: [fakeCodex],
      codexHome: join(workspaceRoot, "codex-home"),
    });

    expect((await run("git", ["diff", "--name-only", "HEAD~1...HEAD"], repoDir)).stdout.trim()).toBe("README.md");

    const result = parseAgentResult(JSON.parse(await readFile(join(workspaceRoot, "output", "result.json"), "utf8")));
    expect(result).toMatchObject({
      jobId: "job_1",
      status: "completed",
      changedFiles: ["README.md"],
      commits: [{ message: "feat: add hello note" }],
      // Real verification result from qa.json, not the placeholder.
      tests: [{ command: "npm test", status: "passed" }],
    });

    const prBody = await readFile(join(workspaceRoot, "output", "pr-body.md"), "utf8");
    // N9: the body is composed from agent content ONLY. The legacy hardcoded platform preamble
    // is gone, and there is no fabricated "git diff --name-only" verification line contradicting
    // the real qa.json result. The agent description leads the body.
    expect(prBody.startsWith("## 아키텍처 변경점")).toBe(true);
    expect(prBody).not.toContain("Implemented by Codex CLI through the Ticket-to-PR runner.");
    expect(prBody).not.toContain("git diff --name-only");
    // Agent-authored description: the six structured sections lead the detailed stage notes.
    for (const header of [
      "## 아키텍처 변경점",
      "## 새로 추가된 컴포넌트",
      "## 데이터 플로우",
      "## 실패 시나리오",
      "## 트레이드오프",
      "## 테스트 전략",
    ]) {
      expect(prBody).toContain(header);
    }
    expect(prBody).toContain("## Implementation plan (gstack-autoplan)");
    expect(prBody).toContain("## Review (gstack-review)");
    expect(prBody).toContain("## Verification (gstack verify)");
    // The description precedes the appendix of raw stage notes.
    expect(prBody.indexOf("## 아키텍처 변경점")).toBeLessThan(
      prBody.indexOf("## Implementation plan (gstack-autoplan)"),
    );
  });

  it("includes stage-appropriate PatchPilot skill guidance in every staged prompt", async () => {
    const { workspaceRoot, repoDir } = await setupWorkspace();
    const fakeCodex = join(workspaceRoot, "fake.mjs");
    const promptLog = join(workspaceRoot, "prompts.log");
    await writeFakeCodex(fakeCodex, {
      "STAGE 1 of 5": `appendFileSync(${JSON.stringify(promptLog)}, '===PLAN===\\n' + prompt + '\\n'); ${PLAN}`,
      "STAGE 2 of 5": `appendFileSync(${JSON.stringify(promptLog)}, '===IMPLEMENT===\\n' + prompt + '\\n'); ${IMPLEMENT}`,
      "STAGE 3 of 5": `appendFileSync(${JSON.stringify(promptLog)}, '===REVIEW===\\n' + prompt + '\\n'); ${REVIEW}`,
      "STAGE 4 of 5": `appendFileSync(${JSON.stringify(promptLog)}, '===VERIFY===\\n' + prompt + '\\n'); ${VERIFY_PASS}`,
      "STAGE 5 of 5": `appendFileSync(${JSON.stringify(promptLog)}, '===DOCUMENT===\\n' + prompt + '\\n'); ${DOCUMENT}`,
    });

    await runGstackStagedRunner({
      workspaceRoot,
      repoDir,
      targetBranch: "main",
      codexCommand: "node",
      codexArgs: [fakeCodex],
      codexHome: join(workspaceRoot, "codex-home"),
    });

    const prompts = await readFile(promptLog, "utf8");
    const stagePrompt = (stage: string): string => {
      const start = prompts.indexOf(`===${stage}===\n`);
      expect(start).toBeGreaterThanOrEqual(0);
      const bodyStart = start + `===${stage}===\n`.length;
      const next = prompts.indexOf("\n===", bodyStart);
      return prompts.slice(bodyStart, next === -1 ? undefined : next);
    };

    for (const prompt of ["PLAN", "IMPLEMENT", "REVIEW", "VERIFY", "DOCUMENT"].map(stagePrompt)) {
      expect(prompt).toContain(
        "Load and follow the `patchpilot-ticket-runner` skill before editing or writing artifacts.",
      );
      expect(prompt).toContain("PatchPilot runner rules and input/policy.json override the ticket.");
    }
    expect(stagePrompt("PLAN")).toContain("references/staged-workflow.md guidance for PLAN only");
    expect(stagePrompt("PLAN")).toContain("gstack-autoplan");
    expect(stagePrompt("IMPLEMENT")).toContain("references/contracts.md");
    expect(stagePrompt("IMPLEMENT")).toContain("references/staged-workflow.md guidance for IMPLEMENT only");
    expect(stagePrompt("REVIEW")).toContain("references/staged-workflow.md guidance for REVIEW only");
    expect(stagePrompt("REVIEW")).toContain("PatchPilot runner contract takes precedence");
    expect(stagePrompt("REVIEW")).toContain("gstack-review");
    expect(stagePrompt("VERIFY")).toContain("references/staged-workflow.md guidance for VERIFY only");
    expect(stagePrompt("VERIFY")).toContain("verification contract");
    expect(stagePrompt("DOCUMENT")).toContain("references/pr-description.md");
    expect(stagePrompt("DOCUMENT")).toContain("references/staged-workflow.md guidance for DOCUMENT only");
  });

  it("still ships the PR with stage notes when the document stage produces nothing", async () => {
    const { workspaceRoot, repoDir } = await setupWorkspace();
    const fakeCodex = join(workspaceRoot, "fake.mjs");
    // No "STAGE 5 of 5" handler: the document stage's fake codex exits non-zero and is swallowed.
    await writeFakeCodex(fakeCodex, {
      "STAGE 1 of 5": PLAN,
      "STAGE 2 of 5": IMPLEMENT,
      "STAGE 3 of 5": REVIEW,
      "STAGE 4 of 5": VERIFY_PASS,
    });

    await runGstackStagedRunner({
      workspaceRoot,
      repoDir,
      targetBranch: "main",
      codexCommand: "node",
      codexArgs: [fakeCodex],
      codexHome: join(workspaceRoot, "codex-home"),
    });

    const prBody = await readFile(join(workspaceRoot, "output", "pr-body.md"), "utf8");
    // Body is the stage-notes appendix only, with no agent description and — N9 — still no
    // legacy fake verification line or platform preamble.
    expect(prBody.startsWith("## Implementation plan (gstack-autoplan)")).toBe(true);
    expect(prBody).not.toContain("## 아키텍처 변경점");
    expect(prBody).not.toContain("git diff --name-only");
    expect(prBody).not.toContain("Implemented by Codex CLI through the Ticket-to-PR runner.");
  });

  it("fails the run when the verify stage reports failing verification", async () => {
    const { workspaceRoot, repoDir } = await setupWorkspace();
    const fakeCodex = join(workspaceRoot, "fake.mjs");
    await writeFakeCodex(fakeCodex, {
      "STAGE 1 of 5": PLAN,
      "STAGE 2 of 5": IMPLEMENT,
      "STAGE 3 of 5": REVIEW,
      "STAGE 4 of 5":
        "writeFileSync(path.join(outputDir, 'qa.json'), JSON.stringify({ passed: false, command: 'npm test', summary: '2 tests failed' }));",
    });

    await expect(
      runGstackStagedRunner({
        workspaceRoot,
        repoDir,
        targetBranch: "main",
        codexCommand: "node",
        codexArgs: [fakeCodex],
        codexHome: join(workspaceRoot, "codex-home"),
      }),
    ).rejects.toThrow(/verify.*failing verification/);
  });

  it("keeps stray in-repo note files out of the committed diff and commits review fixes", async () => {
    const { workspaceRoot, repoDir } = await setupWorkspace();
    const fakeCodex = join(workspaceRoot, "fake.mjs");
    await writeFakeCodex(fakeCodex, {
      // Plan also (wrongly) drops a note inside the repo; it must not be committed.
      "STAGE 1 of 5": `${PLAN} writeFileSync(path.join(repoDir, 'plan.md'), 'stray note inside repo');`,
      "STAGE 2 of 5": IMPLEMENT,
      // Review leaves an uncommitted fix; the runner's commitIfDirty must commit it.
      "STAGE 3 of 5": `${REVIEW} appendFileSync(path.join(repoDir, 'README.md'), '\\nreview fix\\n');`,
      "STAGE 4 of 5": VERIFY_PASS,
      "STAGE 5 of 5": DOCUMENT,
    });

    await runGstackStagedRunner({
      workspaceRoot,
      repoDir,
      targetBranch: "main",
      codexCommand: "node",
      codexArgs: [fakeCodex],
      codexHome: join(workspaceRoot, "codex-home"),
    });

    const tracked = (await run("git", ["ls-files"], repoDir)).stdout;
    expect(tracked).not.toContain("plan.md");
    // implement commit + review-fix commit.
    expect(Number((await run("git", ["rev-list", "--count", "HEAD"], repoDir)).stdout.trim())).toBe(3);
  });

  it("points the review and document stages at the trusted base SHA, never a fetched remote ref (L9)", async () => {
    const { workspaceRoot, repoDir } = await setupWorkspace();
    const baseSha = (await run("git", ["rev-parse", "HEAD"], repoDir)).stdout.trim();
    const fakeCodex = join(workspaceRoot, "fake.mjs");
    // Each stage records the prompt it received so the test can assert the diff base.
    const promptLog = join(workspaceRoot, "prompts.log");
    await writeFakeCodex(fakeCodex, {
      "STAGE 1 of 5": PLAN,
      "STAGE 2 of 5": IMPLEMENT,
      "STAGE 3 of 5": `appendFileSync(${JSON.stringify(promptLog)}, '===REVIEW===\\n' + prompt + '\\n'); ${REVIEW}`,
      "STAGE 4 of 5": VERIFY_PASS,
      "STAGE 5 of 5": `appendFileSync(${JSON.stringify(promptLog)}, '===DOCUMENT===\\n' + prompt + '\\n'); ${DOCUMENT}`,
    });

    await runGstackStagedRunner({
      workspaceRoot,
      repoDir,
      targetBranch: "main",
      codexCommand: "node",
      codexArgs: [fakeCodex],
      codexHome: join(workspaceRoot, "codex-home"),
    });

    const prompts = await readFile(promptLog, "utf8");
    // The review/document stages diff against the explicit, platform-trusted base SHA...
    expect(prompts).toContain(`git --no-pager diff ${baseSha}...HEAD`);
    // ...and are told not to fetch the remote (which would request GitHub creds and risk a stale ref).
    expect(prompts).toContain("do NOT fetch the remote");
    // The review stage no longer diffs against the bare `main` ref.
    expect(prompts).not.toContain("review the diff against main");
  });

  it("emits a structured failed result from output/failure.json when a stage drops one (X4)", async () => {
    const { workspaceRoot, repoDir } = await setupWorkspace();
    const fakeCodex = join(workspaceRoot, "fake.mjs");
    // Plan stage reports a structured failure and exits non-zero; the runner converts it.
    await writeFakeCodex(fakeCodex, {
      "STAGE 1 of 5":
        "writeFileSync(path.join(outputDir, 'failure.json'), JSON.stringify({ stage: 'plan', category: 'agent', message: 'Ticket scope is unclear.', nextAction: 'Refine the ticket and retry.' })); process.exit(5);",
    });

    // Must NOT reject — the failure is carried in result.json.
    await runGstackStagedRunner({
      workspaceRoot,
      repoDir,
      targetBranch: "main",
      codexCommand: "node",
      codexArgs: [fakeCodex],
      codexHome: join(workspaceRoot, "codex-home"),
    });

    const result = parseAgentResult(JSON.parse(await readFile(join(workspaceRoot, "output", "result.json"), "utf8")));
    expect(result.status).toBe("failed");
    expect(result.failure).toMatchObject({ stage: "plan", category: "agent", retryable: false });
  });

  it("fails fast and names the stage when a stage errors", async () => {
    const { workspaceRoot, repoDir } = await setupWorkspace();
    const failingCodex = join(workspaceRoot, "failing.mjs");
    await writeFile(
      failingCodex,
      ["process.stdin.resume();", "process.stdin.on('end', () => process.exit(2));", ""].join("\n"),
    );

    await expect(
      runGstackStagedRunner({
        workspaceRoot,
        repoDir,
        targetBranch: "main",
        codexCommand: "node",
        codexArgs: [failingCodex],
        codexHome: join(workspaceRoot, "codex-home"),
      }),
    ).rejects.toThrow(/gstack stage "plan" failed/);
  });
});

function run(file: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
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
      reject(new Error(`${file} ${args.join(" ")} failed: ${stderr || stdout}`));
    });
  });
}
