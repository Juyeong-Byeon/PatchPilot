import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getWorkspacePaths,
  readJsonArtifact,
  readTextArtifact,
  writeJsonArtifact,
  writeTextArtifact,
} from "../src/index.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "runner-contract-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("getWorkspacePaths", () => {
  it("returns stable input, repo, output, and log artifact paths", async () => {
    const root = await makeTempDir();

    expect(getWorkspacePaths(root)).toEqual({
      inputDir: path.join(root, "input"),
      repoDir: path.join(root, "repo"),
      outputDir: path.join(root, "output"),
      logsDir: path.join(root, "logs"),
      ticketMd: path.join(root, "input", "ticket.md"),
      contextJson: path.join(root, "input", "context.json"),
      policyJson: path.join(root, "input", "policy.json"),
      resultJson: path.join(root, "output", "result.json"),
      prTitle: path.join(root, "output", "pr-title.txt"),
      prBody: path.join(root, "output", "pr-body.md"),
    });
  });
});

describe("artifact helpers", () => {
  it("writes and reads JSON and text artifacts", async () => {
    const root = await makeTempDir();
    const jsonPath = path.join(root, "nested", "result.json");
    const textPath = path.join(root, "nested", "pr-title.txt");

    await writeJsonArtifact(jsonPath, { status: "completed", changedFiles: ["src/a.ts"] });
    await writeTextArtifact(textPath, "Implement ticket\n");

    expect(await readJsonArtifact(jsonPath)).toEqual({ status: "completed", changedFiles: ["src/a.ts"] });
    expect(await readTextArtifact(textPath)).toBe("Implement ticket\n");
    expect(await readFile(jsonPath, "utf8")).toBe(
      '{\n  "status": "completed",\n  "changedFiles": [\n    "src/a.ts"\n  ]\n}\n',
    );
  });
});
