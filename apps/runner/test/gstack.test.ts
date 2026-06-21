import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGstack } from "../src/gstack.js";

const tempDirs: string[] = [];

afterEach(async () => {
  delete process.env.GSTACK_COMMAND;
  delete process.env.GSTACK_ARGS;
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runGstack", () => {
  it("masks secrets before retaining runner logs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-to-pr-gstack-log-"));
    tempDirs.push(dir);
    const command = join(dir, "fake-gstack.sh");
    const logPath = join(dir, "logs", "gstack.log");
    await writeFile(
      command,
      "#!/bin/sh\nprintf 'GITHUB_TOKEN=github_pat_secret\\n'\nprintf 'ghp_abc123\\n' >&2\nprintf 'ghs_123'\nsleep 0.05\nprintf '4567890abcdef\\n'\n",
    );
    await chmod(command, 0o755);
    process.env.GSTACK_COMMAND = command;
    process.env.GSTACK_ARGS = "";

    await runGstack(dir, logPath, 10000);

    const log = await readFile(logPath, "utf8");
    expect(log).not.toContain("github_pat_secret");
    expect(log).not.toContain("ghp_abc123");
    expect(log).not.toContain("ghs_1234567890abcdef");
    expect(log).toContain("[REDACTED_GITHUB_TOKEN]");
  });

  it("forwards (redacted) gstack output to stdout so the platform can see stage banners", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-to-pr-gstack-stdout-"));
    tempDirs.push(dir);
    const command = join(dir, "fake-gstack.sh");
    const logPath = join(dir, "logs", "gstack.log");
    await writeFile(
      command,
      "#!/bin/sh\nprintf '=== gstack stage 1/5: plan ===\\n'\nprintf 'GITHUB_TOKEN=github_pat_secret\\n'\n",
    );
    await chmod(command, 0o755);
    process.env.GSTACK_COMMAND = command;
    process.env.GSTACK_ARGS = "";

    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });

    await runGstack(dir, logPath, 10000);

    const stdout = written.join("");
    // The stage banner reaches stdout (where the worker detects it for the sub-track)...
    expect(stdout).toContain("=== gstack stage 1/5: plan ===");
    // ...and secrets are still redacted on the way out.
    expect(stdout).not.toContain("github_pat_secret");
    expect(stdout).toContain("[REDACTED_GITHUB_TOKEN]");
  });

  it("kills timed out process groups that ignore graceful termination", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-to-pr-gstack-timeout-"));
    tempDirs.push(dir);
    const command = join(dir, "stubborn-gstack.sh");
    const logPath = join(dir, "logs", "gstack.log");
    await writeFile(command, "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nsetTimeout(() => {}, 2000);\n");
    await chmod(command, 0o755);
    process.env.GSTACK_COMMAND = command;
    process.env.GSTACK_ARGS = "";

    const startedAt = Date.now();

    await expect(runGstack(dir, logPath, 300, 50)).rejects.toThrow("gstack timed out");

    expect(Date.now() - startedAt).toBeLessThan(1200);
  });
});
