import { describe, expect, it } from "vitest";
import { readWorkerEnv } from "../src/env.js";

describe("readWorkerEnv", () => {
  it("reads the compose .env variable names", () => {
    const env = readWorkerEnv({
      DATABASE_URL: "postgres://db",
      REDIS_URL: "redis://redis:6379",
      EXECUTOR_MODE: "gstack",
      PUBLISHER_MODE: "mock",
      REPOSITORY_ALLOWLIST: "acme/web, acme/api",
      PROTECTED_PATH_DENYLIST: ".env,infra/**",
      RUNNER_IMAGE: "ticket-to-pr-runner:local",
      JOB_WORKSPACE_ROOT: "/work/jobs",
      WORKER_WORKSPACE_HOST_ROOT: "/Users/me/ticket-to-pr/work/jobs",
      GSTACK_COMMAND: "node",
      GSTACK_ARGS: "/opt/runner/apps/runner/dist/e2e-smoke-runner.js",
      JOB_TIMEOUT_SECONDS: "120"
    });

    expect(env.executorMode).toBe("gstack");
    expect(env.publisherMode).toBe("mock");
    expect(env.repositoryAllowlist).toEqual(["acme/web", "acme/api"]);
    expect(env.protectedPathDenylist).toEqual([".env", "infra/**"]);
    expect(env.runnerImage).toBe("ticket-to-pr-runner:local");
    expect(env.workspaceRoot).toBe("/work/jobs");
    expect((env as { workspaceHostRoot?: string }).workspaceHostRoot).toBe("/Users/me/ticket-to-pr/work/jobs");
    expect((env as { gstackCommand?: string }).gstackCommand).toBe("node");
    expect((env as { gstackArgs?: string }).gstackArgs).toBe("/opt/runner/apps/runner/dist/e2e-smoke-runner.js");
    expect(env.jobTimeoutSeconds).toBe(120);
  });

  it("treats legacy app-wide PUBLISHER_MODE=gstack as GitHub publishing", () => {
    const env = readWorkerEnv({
      EXECUTOR_MODE: "gstack",
      PUBLISHER_MODE: "gstack",
      GITHUB_TOKEN: "github_pat_secret"
    });

    expect(env.executorMode).toBe("gstack");
    expect(env.publisherMode).toBe("github");
  });

  it("keeps explicit worker publisher mode strict", () => {
    expect(() =>
      readWorkerEnv({
        WORKER_PUBLISHER_MODE: "gstack",
        GITHUB_TOKEN: "github_pat_secret"
      })
    ).toThrow("Invalid worker mode: gstack");
  });
});
