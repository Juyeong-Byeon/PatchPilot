import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAgentResult } from "@ticket-to-pr/core";
import { runE2eSmokeRunner } from "../src/e2e-smoke-runner.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runE2eSmokeRunner", () => {
  it("creates a README-only local commit and runner artifacts", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ticket-to-pr-e2e-runner-"));
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
      join(inputDir, "context.json"),
      JSON.stringify(
        {
          jobId: "job_1",
          ticketSnapshotId: "ts_1",
          triggerVersion: "README.md only",
          runId: "run_1",
          attempt: 1,
          workBranch: "ticket-to-pr/job_1",
        },
        null,
        2,
      ),
    );

    await runE2eSmokeRunner({
      workspaceRoot,
      repoDir,
      targetBranch: "main",
    });

    expect((await run("git", ["diff", "--name-only", "HEAD~1...HEAD"], repoDir)).stdout.trim()).toBe("README.md");
    expect((await readFile(join(repoDir, "README.md"), "utf8")).trim()).toContain("Lark automation smoke test");

    const result = parseAgentResult(JSON.parse(await readFile(join(workspaceRoot, "output", "result.json"), "utf8")));
    expect(result).toMatchObject({
      jobId: "job_1",
      runId: "run_1",
      ticketId: "ts_1",
      triggerVersion: "README.md only",
      status: "completed",
      changedFiles: ["README.md"],
      failure: null,
      retryable: false,
    });
    expect(await readFile(join(workspaceRoot, "output", "pr-title.txt"), "utf8")).toContain("Lark automation smoke");
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
