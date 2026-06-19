import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGstack } from "../src/gstack.js";

const tempDirs: string[] = [];

afterEach(async () => {
  delete process.env.GSTACK_COMMAND;
  delete process.env.GSTACK_ARGS;
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
      "#!/bin/sh\nprintf 'GITHUB_TOKEN=github_pat_secret\\n'\nprintf 'ghp_abc123\\n' >&2\nprintf 'ghs_123'\nsleep 0.05\nprintf '4567890abcdef\\n'\n"
    );
    await chmod(command, 0o755);
    process.env.GSTACK_COMMAND = command;
    process.env.GSTACK_ARGS = "";

    await runGstack(dir, logPath, 1000);

    const log = await readFile(logPath, "utf8");
    expect(log).not.toContain("github_pat_secret");
    expect(log).not.toContain("ghp_abc123");
    expect(log).not.toContain("ghs_1234567890abcdef");
    expect(log).toContain("[REDACTED_GITHUB_TOKEN]");
  });
});
