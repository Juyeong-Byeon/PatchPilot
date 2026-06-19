import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getWorkspacePaths } from "@ticket-to-pr/runner-contract";
import { prepareWorkspace } from "../src/workspace.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "runner-workspace-"));
  tempDirs.push(dir);
  return dir;
}

async function expectDirectory(dir: string): Promise<void> {
  await expect(stat(dir).then((value) => value.isDirectory())).resolves.toBe(true);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("prepareWorkspace", () => {
  it("creates all runner workspace directories and returns their paths", async () => {
    const root = path.join(await makeTempDir(), "workspace");

    const paths = await prepareWorkspace(root);

    expect(paths).toEqual(getWorkspacePaths(root));
    await expectDirectory(paths.inputDir);
    await expectDirectory(paths.repoDir);
    await expectDirectory(paths.outputDir);
    await expectDirectory(paths.logsDir);
  });
});
