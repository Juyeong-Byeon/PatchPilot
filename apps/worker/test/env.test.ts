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
      JOB_TIMEOUT_SECONDS: "120"
    });

    expect(env.executorMode).toBe("gstack");
    expect(env.publisherMode).toBe("mock");
    expect(env.repositoryAllowlist).toEqual(["acme/web", "acme/api"]);
    expect(env.protectedPathDenylist).toEqual([".env", "infra/**"]);
    expect(env.runnerImage).toBe("ticket-to-pr-runner:local");
    expect(env.workspaceRoot).toBe("/work/jobs");
    expect(env.jobTimeoutSeconds).toBe(120);
  });
});
