import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAgentResult } from "@ticket-to-pr/core";
import { composePrBody, runCodexAgentRunner } from "../src/codex-agent-runner.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runCodexAgentRunner", () => {
  it("runs a Codex-compatible command and writes runner artifacts from trusted git evidence", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ticket-to-pr-codex-runner-"));
    tempDirs.push(workspaceRoot);
    const repoDir = join(workspaceRoot, "repo");
    const inputDir = join(workspaceRoot, "input");
    const fakeCodex = join(workspaceRoot, "fake-codex.mjs");
    const codexHome = join(workspaceRoot, "codex-home");
    const seedDir = join(workspaceRoot, "seed");

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
      [
        "# Add Codex smoke note",
        "",
        "## Description",
        "Append one short Codex smoke note to README.md.",
        "",
        "## Definition of Done",
        "README.md contains a Codex smoke note.",
      ].join("\n"),
    );
    await writeFile(
      join(inputDir, "context.json"),
      JSON.stringify(
        {
          jobId: "job_1",
          ticketSnapshotId: "ts_1",
          triggerVersion: "codex real runner",
          runId: "run_1",
          attempt: 1,
          workBranch: "ticket-to-pr/job_1",
        },
        null,
        2,
      ),
    );
    await writeFile(join(inputDir, "policy.json"), JSON.stringify({ repositoryAllowlist: ["owner/repo"] }, null, 2));
    await writeFile(
      fakeCodex,
      [
        "import { appendFileSync } from 'node:fs';",
        "import { spawnSync } from 'node:child_process';",
        "let prompt = '';",
        "process.stdin.on('data', (chunk) => { prompt += chunk.toString('utf8'); });",
        "process.stdin.on('end', () => {",
        "  if (!prompt.includes('input/ticket.md')) process.exit(3);",
        "  appendFileSync('README.md', '\\n## Codex smoke note\\n\\nCreated by fake Codex.\\n');",
        "  spawnSync('git', ['add', 'README.md'], { stdio: 'inherit' });",
        "  spawnSync('git', ['commit', '-m', 'docs: add Codex smoke note'], { stdio: 'inherit' });",
        "});",
        "",
      ].join("\n"),
    );

    await runCodexAgentRunner({
      workspaceRoot,
      repoDir,
      targetBranch: "master",
      codexCommand: "node",
      codexArgs: [fakeCodex],
      codexHome,
      codexAuthFile: join(seedDir, "auth.json"),
      codexConfigFile: join(seedDir, "config.toml"),
    });

    expect((await run("git", ["diff", "--name-only", "HEAD~1...HEAD"], repoDir)).stdout.trim()).toBe("README.md");
    expect(await readFile(join(codexHome, "auth.json"), "utf8")).toBe("{}\n");
    expect(await readFile(join(codexHome, "config.toml"), "utf8")).toBe('model = "test"\n');

    const result = parseAgentResult(JSON.parse(await readFile(join(workspaceRoot, "output", "result.json"), "utf8")));
    expect(result).toMatchObject({
      jobId: "job_1",
      runId: "run_1",
      ticketId: "ts_1",
      triggerVersion: "codex real runner",
      status: "completed",
      changedFiles: ["README.md"],
      commits: [{ message: "docs: add Codex smoke note" }],
      failure: null,
      retryable: false,
    });
    // N2: single-pass runs no project verification, so tests must be honestly skipped — never a
    // fabricated "passed". The platform/policy layer surfaces "skipped" as "no verification".
    expect(result.tests).toEqual([
      {
        command: "project verification",
        status: "skipped",
        summary: "Single-pass runner did not run project verification.",
      },
    ]);
    expect(await readFile(join(workspaceRoot, "output", "pr-title.txt"), "utf8")).toContain(
      "docs: add Codex smoke note",
    );
    const prBody = await readFile(join(workspaceRoot, "output", "pr-body.md"), "utf8");
    // Honest minimal Summary lists the changed files.
    expect(prBody).toContain("## Summary");
    expect(prBody).toContain("README.md");
    // N9: the legacy fake "## Verification\n- git diff --name-only" block is gone — the runner
    // must not emit a fabricated verification line that contradicts the platform's real evidence.
    expect(prBody).not.toContain("## Verification");
    expect(prBody).not.toContain("git diff --name-only");
  });
});

describe("composePrBody", () => {
  it("emits a minimal honest Summary (no fake verification) when there are no agent sections", () => {
    const body = composePrBody({ changedFiles: ["src/a.ts", "src/b.ts"] });
    expect(body).toContain("## Summary");
    expect(body).toContain("src/a.ts, src/b.ts");
    // No fabricated verification block / line.
    expect(body).not.toContain("## Verification");
    expect(body).not.toContain("git diff --name-only");
  });

  it("composes the body from agent sections only, with no platform preamble", () => {
    const sections = ["## 아키텍처 변경점\n- 변경", "## Verification (gstack verify)\n- npm run ci passed"];
    const body = composePrBody({ changedFiles: ["src/a.ts"], prBodySections: sections });
    // Agent content is preserved verbatim; the legacy hardcoded Summary preamble is gone.
    expect(body).toBe(sections.join("\n\n"));
    expect(body.startsWith("## 아키텍처 변경점")).toBe(true);
    expect(body).not.toContain("Implemented by Codex CLI");
    expect(body).not.toContain("git diff --name-only");
  });

  it("falls back to the honest Summary when all agent sections are blank", () => {
    const body = composePrBody({ changedFiles: ["src/a.ts"], prBodySections: ["", "   "] });
    expect(body).toContain("## Summary");
    expect(body).toContain("src/a.ts");
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
