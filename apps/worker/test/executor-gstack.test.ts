import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildGstackDockerCommand, maskExecutorOutput, writeRunnerInputArtifacts } from "../src/executor-gstack.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("buildGstackDockerCommand", () => {
  it("constructs a network-isolated Docker command without mounting the Docker socket", () => {
    const command = buildGstackDockerCommand({
      runnerImage: "ghcr.io/acme/ticket-runner@sha256:abc",
      workspacePath: "/var/tmp/ticket-to-pr/job_1",
      job: {
        jobId: "job_1",
        ticketSnapshotId: "ts_1",
        larkRecordId: "rec_1",
        triggerVersion: "v1",
        repository: "acme/web",
        targetBranch: "main"
      },
      run: { runId: "run_1", attempt: 2, workBranch: "ticket-to-pr/job_1" }
    });

    expect(command.file).toBe("docker");
    expect(command.args).toEqual(
      expect.arrayContaining([
        "run",
        "--rm",
        "--network",
        "none",
        "--cpus",
        "2",
        "--memory",
        "4g",
        "-v",
        "/var/tmp/ticket-to-pr/job_1:/work/jobs/job_1",
        "-e",
        "JOB_ID=job_1",
        "-e",
        "RUN_ID=run_1",
        "-e",
        "WORKSPACE_ROOT=/work/jobs/job_1",
        "-e",
        "REPOSITORY_URL=https://github.com/acme/web.git",
        "-e",
        "TARGET_BRANCH=main",
        "-e",
        "WORK_BRANCH=ticket-to-pr/job_1",
        "-e",
        "TIMEOUT_SECONDS=3600",
        "ghcr.io/acme/ticket-runner@sha256:abc"
      ])
    );
    expect(command.args.join(" ")).not.toContain("/var/run/docker.sock");
  });

  it("masks secrets before logs are persisted", () => {
    const masked = maskExecutorOutput("GITHUB_TOKEN=github_pat_secret ghp_abc123");

    expect(masked.text).toContain("GITHUB_TOKEN=[REDACTED_GITHUB_TOKEN]");
    expect(masked.text).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(masked.redactionApplied).toBe(true);
  });

  it("writes ticket, context, and policy artifacts for the runner", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "ticket-to-pr-runner-input-"));
    tempDirs.push(workspacePath);

    await writeRunnerInputArtifacts({
      workspacePath,
      job: {
        jobId: "job_1",
        ticketSnapshotId: "ts_1",
        larkRecordId: "rec_1",
        triggerVersion: "v1",
        title: "Fix login",
        description: "Login fails",
        definitionOfDone: "Users can log in",
        repository: "acme/web",
        targetBranch: "main"
      },
      run: { runId: "run_1", attempt: 1, workBranch: "ticket-to-pr/job_1" },
      policy: { repositoryAllowlist: ["acme/web"], protectedPathDenylist: ["infra/**"] }
    });

    expect(await readFile(join(workspacePath, "input", "ticket.md"), "utf8")).toContain("Fix login");
    expect(JSON.parse(await readFile(join(workspacePath, "input", "context.json"), "utf8"))).toMatchObject({
      jobId: "job_1",
      runId: "run_1"
    });
    expect(JSON.parse(await readFile(join(workspacePath, "input", "policy.json"), "utf8"))).toEqual({
      repositoryAllowlist: ["acme/web"],
      protectedPathDenylist: ["infra/**"]
    });
  });
});
