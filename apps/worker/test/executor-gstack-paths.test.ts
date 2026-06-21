import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mapWorkspacePathForDockerMount, runnerContainerName } from "../src/executor-gstack.js";

describe("mapWorkspacePathForDockerMount", () => {
  it("returns the workspace path unchanged when no host root is configured", () => {
    expect(mapWorkspacePathForDockerMount("/work/jobs/job_1/run_1")).toBe("/work/jobs/job_1/run_1");
    // An explicit workspace root without a host root is still a no-op.
    expect(mapWorkspacePathForDockerMount("/work/jobs/job_1/run_1", "/work/jobs")).toBe("/work/jobs/job_1/run_1");
  });

  it("remaps a path inside the workspace root onto the host root", () => {
    const mapped = mapWorkspacePathForDockerMount(
      "/work/jobs/job_1/run_1",
      "/work/jobs",
      "/Users/me/ticket-to-pr/work/jobs",
    );

    expect(mapped).toBe(join("/Users/me/ticket-to-pr/work/jobs", "job_1/run_1"));
    expect(mapped).toBe("/Users/me/ticket-to-pr/work/jobs/job_1/run_1");
  });

  it("uses the default worker workspace root when none is supplied", () => {
    const mapped = mapWorkspacePathForDockerMount("/tmp/ticket-to-pr-worker/job_1/run_1", undefined, "/Users/me/host");

    expect(mapped).toBe(join("/Users/me/host", "job_1/run_1"));
    expect(mapped).toBe("/Users/me/host/job_1/run_1");
  });

  it("maps the workspace root itself to the host root", () => {
    expect(mapWorkspacePathForDockerMount("/work/jobs", "/work/jobs", "/Users/me/host")).toBe("/Users/me/host");
  });

  it("throws when the workspace path escapes the root via '..'", () => {
    expect(() => mapWorkspacePathForDockerMount("/work/elsewhere/run_1", "/work/jobs", "/Users/me/host")).toThrow(
      "Runner workspace path must stay inside the worker workspace root",
    );
  });

  it("throws when the workspace path is on a sibling tree of the root", () => {
    // resolve("/work/jobs-evil") relative to "/work/jobs" starts with ".." → escape.
    expect(() => mapWorkspacePathForDockerMount("/work/jobs-evil/run_1", "/work/jobs", "/Users/me/host")).toThrow(
      "Runner workspace path must stay inside the worker workspace root",
    );
  });
});

describe("runnerContainerName", () => {
  it("prefixes a clean runId with the project namespace", () => {
    expect(runnerContainerName("run_1")).toBe("ticket-to-pr-run_1");
    // Already-allowed characters (letters, digits, '_', '.', '-') are preserved.
    expect(runnerContainerName("Run.1-2_3")).toBe("ticket-to-pr-Run.1-2_3");
  });

  it("sanitizes illegal characters (slash, colon, space) to '-'", () => {
    expect(runnerContainerName("run/1")).toBe("ticket-to-pr-run-1");
    expect(runnerContainerName("run:1")).toBe("ticket-to-pr-run-1");
    expect(runnerContainerName("run 1")).toBe("ticket-to-pr-run-1");
    expect(runnerContainerName("a/b:c d")).toBe("ticket-to-pr-a-b-c-d");
  });

  it("produces a name containing only docker-safe characters", () => {
    expect(runnerContainerName("weird/id:with spaces!*")).toMatch(/^[a-zA-Z0-9_.-]+$/);
  });
});
