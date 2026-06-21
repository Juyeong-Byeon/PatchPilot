import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  gcSuccessfulWorkspace,
  sweepExpiredWorkspaces,
  sweepOrphanRunnerContainers,
} from "../src/workspace-lifecycle.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ttp-lifecycle-"));
  tempDirs.push(root);
  return root;
}

describe("gcSuccessfulWorkspace", () => {
  it("removes the per-job workspace directory", async () => {
    const root = await makeRoot();
    const jobDir = join(root, "job_1", "run_1");
    await mkdir(jobDir, { recursive: true });
    await writeFile(join(jobDir, "result.json"), "{}");

    await gcSuccessfulWorkspace("job_1", { workspaceRoot: root });

    await expect(stat(join(root, "job_1"))).rejects.toThrow();
  });

  it("is a no-op when the workspace does not exist", async () => {
    const root = await makeRoot();
    await expect(gcSuccessfulWorkspace("missing", { workspaceRoot: root })).resolves.toBeUndefined();
  });
});

describe("sweepExpiredWorkspaces", () => {
  it("removes job dirs older than the retention window and keeps fresh ones", async () => {
    const root = await makeRoot();
    const oldDir = join(root, "job_old");
    const freshDir = join(root, "job_fresh");
    await mkdir(oldDir, { recursive: true });
    await mkdir(freshDir, { recursive: true });
    // Age the old dir 10 days into the past.
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await utimes(oldDir, tenDaysAgo, tenDaysAgo);

    const removed = await sweepExpiredWorkspaces({ workspaceRoot: root, failedRetentionDays: 7 });

    expect(removed).toEqual([oldDir]);
    await expect(stat(oldDir)).rejects.toThrow();
    await expect(stat(freshDir)).resolves.toBeTruthy();
  });

  it("returns [] when the workspace root does not exist", async () => {
    const removed = await sweepExpiredWorkspaces({
      workspaceRoot: join(tmpdir(), "ttp-does-not-exist-xyz"),
      failedRetentionDays: 7,
    });
    expect(removed).toEqual([]);
  });
});

describe("sweepOrphanRunnerContainers", () => {
  it("removes orphan containers but keeps containers for active runs", async () => {
    const docker = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === "ps") return "ticket-to-pr-run_active\nticket-to-pr-run_orphan\nunrelated-container\n";
      return "";
    });

    const removed = await sweepOrphanRunnerContainers(new Set(["run_active"]), undefined, docker);

    expect(removed).toEqual(["ticket-to-pr-run_orphan"]);
    expect(docker).toHaveBeenCalledWith(["rm", "-f", "ticket-to-pr-run_orphan"]);
    expect(docker).not.toHaveBeenCalledWith(["rm", "-f", "ticket-to-pr-run_active"]);
  });

  it("is a safe no-op when docker is unavailable", async () => {
    const onError = vi.fn();
    const docker = vi.fn().mockRejectedValue(new Error("docker: command not found"));
    const removed = await sweepOrphanRunnerContainers(new Set(), onError, docker);
    expect(removed).toEqual([]);
    expect(onError).toHaveBeenCalled();
  });
});
