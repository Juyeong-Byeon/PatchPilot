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

describe("runGstackStagedRunner", () => {
  it("runs plan -> implement -> review -> verify and folds stage notes into the PR body", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ticket-to-pr-gstack-runner-"));
    tempDirs.push(workspaceRoot);
    const repoDir = join(workspaceRoot, "repo");
    const inputDir = join(workspaceRoot, "input");
    const seedDir = join(workspaceRoot, "seed");
    const codexHome = join(workspaceRoot, "codex-home");
    const fakeCodex = join(workspaceRoot, "fake-staged-codex.mjs");

    await mkdir(inputDir, { recursive: true });
    await mkdir(seedDir, { recursive: true });
    await writeFile(join(seedDir, "auth.json"), "{}\n");
    await writeFile(join(seedDir, "config.toml"), 'model = "test"\n');
    await run("git", ["init", repoDir]);
    await run("git", ["config", "user.name", "Test User"], repoDir);
    await run("git", ["config", "user.email", "test@example.com"], repoDir);
    await writeFile(join(repoDir, "README.md"), "# Test repo\n");
    await run("git", ["add", "README.md"], repoDir);
    await run("git", ["commit", "-m", "Initial commit"], repoDir);

    await writeFile(
      join(inputDir, "ticket.md"),
      ["# Add hello note", "", "## Description", "Append a hello note to README.md."].join("\n"),
    );
    await writeFile(
      join(inputDir, "context.json"),
      JSON.stringify(
        {
          jobId: "job_1",
          ticketSnapshotId: "ts_1",
          triggerVersion: "gstack staged",
          runId: "run_1",
          attempt: 1,
          workBranch: "ticket-to-pr/job_1",
        },
        null,
        2,
      ),
    );
    await writeFile(join(inputDir, "policy.json"), JSON.stringify({ repositoryAllowlist: ["owner/repo"] }, null, 2));

    // Fake Codex: one process per stage, dispatched by the stage marker in the prompt.
    // cwd is the repo dir; the output dir is its sibling (workspace/output).
    await writeFile(
      fakeCodex,
      [
        "import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';",
        "import { spawnSync } from 'node:child_process';",
        "import path from 'node:path';",
        "let prompt = '';",
        "process.stdin.on('data', (chunk) => { prompt += chunk.toString('utf8'); });",
        "process.stdin.on('end', () => {",
        "  const repoDir = process.cwd();",
        "  const outputDir = path.join(repoDir, '..', 'output');",
        "  mkdirSync(outputDir, { recursive: true });",
        "  if (prompt.includes('STAGE 1 of 4')) {",
        "    writeFileSync(path.join(outputDir, 'plan.md'), '# Plan\\n- Append a hello note to README.md\\n');",
        "  } else if (prompt.includes('STAGE 2 of 4')) {",
        "    appendFileSync(path.join(repoDir, 'README.md'), '\\nhello from staged pipeline\\n');",
        "    spawnSync('git', ['add', 'README.md'], { cwd: repoDir });",
        "    spawnSync('git', ['commit', '-m', 'feat: add hello note'], { cwd: repoDir });",
        "  } else if (prompt.includes('STAGE 3 of 4')) {",
        "    writeFileSync(path.join(outputDir, 'review.md'), '# Review\\n- No blocking issues\\n');",
        "  } else if (prompt.includes('STAGE 4 of 4')) {",
        "    writeFileSync(path.join(outputDir, 'qa.md'), '# QA\\n- Verification passed\\n');",
        "  } else {",
        "    process.exit(3);",
        "  }",
        "});",
        "",
      ].join("\n"),
    );

    await runGstackStagedRunner({
      workspaceRoot,
      repoDir,
      targetBranch: "main",
      codexCommand: "node",
      codexArgs: [fakeCodex],
      codexHome,
      codexAuthFile: join(seedDir, "auth.json"),
      codexConfigFile: join(seedDir, "config.toml"),
    });

    // Implement stage produced exactly the ticketed change.
    expect((await run("git", ["diff", "--name-only", "HEAD~1...HEAD"], repoDir)).stdout.trim()).toBe("README.md");

    const result = parseAgentResult(JSON.parse(await readFile(join(workspaceRoot, "output", "result.json"), "utf8")));
    expect(result).toMatchObject({
      jobId: "job_1",
      runId: "run_1",
      status: "completed",
      changedFiles: ["README.md"],
      commits: [{ message: "feat: add hello note" }],
      failure: null,
    });

    // Each stage's notes are folded into the PR body.
    const prBody = await readFile(join(workspaceRoot, "output", "pr-body.md"), "utf8");
    expect(prBody).toContain("## Implementation plan (gstack-autoplan)");
    expect(prBody).toContain("## Review (gstack-review)");
    expect(prBody).toContain("## Verification (gstack qa)");
    expect(prBody).toContain("No blocking issues");

    // The stage note files stayed out of the committed diff.
    expect((await run("git", ["ls-files"], repoDir)).stdout).not.toContain("plan.md");
  });

  it("fails fast and names the stage when a stage errors", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ticket-to-pr-gstack-fail-"));
    tempDirs.push(workspaceRoot);
    const repoDir = join(workspaceRoot, "repo");
    const inputDir = join(workspaceRoot, "input");
    const failingCodex = join(workspaceRoot, "failing-codex.mjs");

    await mkdir(inputDir, { recursive: true });
    await run("git", ["init", repoDir]);
    await run("git", ["config", "user.name", "Test User"], repoDir);
    await run("git", ["config", "user.email", "test@example.com"], repoDir);
    await writeFile(join(repoDir, "README.md"), "# Test repo\n");
    await run("git", ["add", "README.md"], repoDir);
    await run("git", ["commit", "-m", "Initial commit"], repoDir);
    await writeFile(join(inputDir, "ticket.md"), "# Ticket\n");
    await writeFile(
      join(inputDir, "context.json"),
      JSON.stringify({
        jobId: "job_1",
        ticketSnapshotId: "ts_1",
        triggerVersion: "v",
        runId: "run_1",
        attempt: 1,
        workBranch: "b",
      }),
    );
    await writeFile(join(inputDir, "policy.json"), "{}\n");
    // Always exits non-zero -> the first (plan) stage fails.
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
