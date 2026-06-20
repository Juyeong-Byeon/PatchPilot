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

describe("runGstackStagedRunner", () => {
  it("runs plan -> implement -> review -> verify, gates on qa.json, folds notes into the PR body", async () => {
    const { workspaceRoot, repoDir } = await setupWorkspace();
    const fakeCodex = join(workspaceRoot, "fake.mjs");
    await writeFakeCodex(fakeCodex, {
      "STAGE 1 of 4": PLAN,
      "STAGE 2 of 4": IMPLEMENT,
      "STAGE 3 of 4": REVIEW,
      "STAGE 4 of 4": VERIFY_PASS,
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
    expect(prBody).toContain("## Implementation plan (gstack-autoplan)");
    expect(prBody).toContain("## Review (gstack-review)");
    expect(prBody).toContain("## Verification (gstack verify)");
  });

  it("fails the run when the verify stage reports failing verification", async () => {
    const { workspaceRoot, repoDir } = await setupWorkspace();
    const fakeCodex = join(workspaceRoot, "fake.mjs");
    await writeFakeCodex(fakeCodex, {
      "STAGE 1 of 4": PLAN,
      "STAGE 2 of 4": IMPLEMENT,
      "STAGE 3 of 4": REVIEW,
      "STAGE 4 of 4":
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
      "STAGE 1 of 4": `${PLAN} writeFileSync(path.join(repoDir, 'plan.md'), 'stray note inside repo');`,
      "STAGE 2 of 4": IMPLEMENT,
      // Review leaves an uncommitted fix; the runner's commitIfDirty must commit it.
      "STAGE 3 of 4": `${REVIEW} appendFileSync(path.join(repoDir, 'README.md'), '\\nreview fix\\n');`,
      "STAGE 4 of 4": VERIFY_PASS,
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
