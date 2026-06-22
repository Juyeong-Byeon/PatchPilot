import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script, no type declarations.
import { classifyReadyFailure, formatConfigForDisplay, readConfig, usageText } from "./e2e-smoke.mjs";

describe("e2e-smoke script", () => {
  it("loads .env-style values before built-in defaults", () => {
    const config = readConfig({
      envFile: {
        ADMIN_TOKEN: "from-env",
        E2E_READY_TIMEOUT_MS: "1234",
        HOST_API_PORT: "3002",
        REPOSITORY_ALLOWLIST: "acme/app,acme/api",
      },
      processEnv: {},
    });

    expect(config.baseUrl).toBe("http://localhost:3002");
    expect(config.adminToken).toBe("from-env");
    expect(config.repository).toBe("acme/app");
    expect(config.readyTimeoutMs).toBe(1234);
  });

  it("lets process env override .env for ad-hoc smoke runs", () => {
    const config = readConfig({
      envFile: { HOST_API_PORT: "3002", REPOSITORY_ALLOWLIST: "acme/app" },
      processEnv: { E2E_BASE_URL: "http://127.0.0.1:4010/" },
    });

    expect(config.baseUrl).toBe("http://127.0.0.1:4010");
  });

  it("has a help and print-config surface that does not start the smoke", () => {
    expect(usageText()).toContain("--help");
    expect(usageText()).toContain("--print-config");
  });

  it("prints effective config without leaking secrets", () => {
    const output = formatConfigForDisplay(
      readConfig({
        envFile: {
          ADMIN_TOKEN: "super-secret-admin",
          GITHUB_WEBHOOK_SECRET: "super-secret-github",
          HOST_API_PORT: "3002",
          LARK_WEBHOOK_SECRET: "super-secret-lark",
          REPOSITORY_ALLOWLIST: "acme/app",
        },
        processEnv: {},
      }),
    );

    expect(output).toContain("baseUrl: http://localhost:3002");
    expect(output).toContain("repository: acme/app");
    expect(output).toContain("adminToken: <set>");
    expect(output).not.toContain("super-secret");
  });

  it("fast-fails when /api/ready is answered by a different web service", () => {
    const result = classifyReadyFailure({
      body: "<!doctype html><html><title>Vite</title></html>",
      contentType: "text/html; charset=utf-8",
      status: 404,
    });

    expect(result.retry).toBe(false);
    expect(result.message).toContain("wrong service");
    expect(result.message).toContain("HOST_API_PORT");
  });
});
