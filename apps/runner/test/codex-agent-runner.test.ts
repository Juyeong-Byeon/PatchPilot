import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAgentResult } from "@ticket-to-pr/core";
import { runCodexAgentRunner } from "../src/codex-agent-runner.js";

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
    await writeFile(join(seedDir, "config.toml"), "model = \"test\"\n");
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
        "README.md contains a Codex smoke note."
      ].join("\n")
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
          workBranch: "ticket-to-pr/job_1"
        },
        null,
        2
      )
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
        ""
      ].join("\n")
    );

    await runCodexAgentRunner({
      workspaceRoot,
      repoDir,
      targetBranch: "master",
      codexCommand: "node",
      codexArgs: [fakeCodex],
      codexHome,
      codexAuthFile: join(seedDir, "auth.json"),
      codexConfigFile: join(seedDir, "config.toml")
    });

    expect((await run("git", ["diff", "--name-only", "HEAD~1...HEAD"], repoDir)).stdout.trim()).toBe("README.md");
    expect(await readFile(join(codexHome, "auth.json"), "utf8")).toBe("{}\n");
    expect(await readFile(join(codexHome, "config.toml"), "utf8")).toBe("model = \"test\"\n");

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
      retryable: false
    });
    expect(await readFile(join(workspaceRoot, "output", "pr-title.txt"), "utf8")).toContain("docs: add Codex smoke note");
    expect(await readFile(join(workspaceRoot, "output", "pr-body.md"), "utf8")).toContain("README.md");
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
