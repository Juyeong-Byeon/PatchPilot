import { describe, expect, it } from "vitest";
import { readApiEnv } from "../src/env.js";

const COMPLETE = {
  DATABASE_URL: "postgres://localhost/db",
  REDIS_URL: "redis://localhost:6379",
  ADMIN_TOKEN: "admin",
  LARK_WEBHOOK_SECRET: "lark",
} satisfies NodeJS.ProcessEnv;

describe("readApiEnv", () => {
  it("parses a complete environment with PORT defaulted", () => {
    const env = readApiEnv(COMPLETE);
    expect(env).toMatchObject({
      databaseUrl: "postgres://localhost/db",
      redisUrl: "redis://localhost:6379",
      adminToken: "admin",
      larkWebhookSecret: "lark",
      port: 3000,
      githubWebhookSecret: undefined,
    });
  });

  it("reports ALL missing required vars at once (fail-fast aggregation)", () => {
    let message = "";
    try {
      readApiEnv({});
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("DATABASE_URL is required");
    expect(message).toContain("REDIS_URL is required");
    expect(message).toContain("ADMIN_TOKEN is required");
    expect(message).toContain("LARK_WEBHOOK_SECRET is required");
  });

  it("treats a blank required var as absent", () => {
    expect(() => readApiEnv({ ...COMPLETE, DATABASE_URL: "   " })).toThrow(/DATABASE_URL is required/);
  });

  it("coerces a numeric PORT and rejects a non-numeric one", () => {
    expect(readApiEnv({ ...COMPLETE, PORT: "8080" }).port).toBe(8080);
    expect(() => readApiEnv({ ...COMPLETE, PORT: "abc" })).toThrow(/PORT/);
  });

  it("keeps GITHUB_WEBHOOK_SECRET optional, trimming blanks to undefined", () => {
    expect(readApiEnv({ ...COMPLETE, GITHUB_WEBHOOK_SECRET: "gh" }).githubWebhookSecret).toBe("gh");
    expect(readApiEnv({ ...COMPLETE, GITHUB_WEBHOOK_SECRET: "  " }).githubWebhookSecret).toBeUndefined();
  });
});
