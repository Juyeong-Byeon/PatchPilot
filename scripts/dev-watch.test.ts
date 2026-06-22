import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error — plain .mjs script, no type declarations.
import { buildDevWatchProcesses, buildDevWatchSetupPlan, hostDevelopmentEnv } from "./dev-watch.mjs";

describe("dev-watch script", () => {
  it("prepares infra without rebuilding Docker app images", () => {
    const plan = buildDevWatchSetupPlan();

    expect(plan.map((step: { command: string; args: string[] }) => [step.command, step.args])).toEqual([
      ["docker", ["compose", "up", "-d", "--wait", "postgres", "redis"]],
      ["docker", ["compose", "stop", "api", "worker"]],
      ["npm", ["run", "build"]],
    ]);
    expect(JSON.stringify(plan)).not.toContain("--build");
  });

  it("rewrites container service URLs and aligns the API/admin dev port", () => {
    const env = hostDevelopmentEnv({
      DATABASE_URL: "postgres://ticket_to_pr:ticket_to_pr@postgres:5432/ticket_to_pr",
      REDIS_URL: "redis://redis:6379",
      HOST_API_PORT: "3002",
    });

    expect(env.DATABASE_URL).toBe("postgres://ticket_to_pr:ticket_to_pr@localhost:5432/ticket_to_pr");
    expect(env.REDIS_URL).toBe("redis://localhost:6379");
    expect(env.PORT).toBe("3002");
    expect(env.HOST_API_PORT).toBe("3002");
  });

  it("runs TypeScript watchers plus API, worker, and admin dev servers", () => {
    const processes = buildDevWatchProcesses({ HOST_API_PORT: "3002" });

    expect(processes.map((process: { name: string }) => process.name)).toEqual([
      "watch:core",
      "watch:db",
      "watch:queue",
      "watch:runner-contract",
      "watch:api",
      "watch:worker",
      "watch:runner",
      "dev:api",
      "dev:worker",
      "dev:admin",
    ]);
    expect(processes.find((process: { name: string }) => process.name === "watch:api")?.args).toEqual([
      "--workspace",
      "@ticket-to-pr/api",
      "run",
      "build",
      "--",
      "--watch",
      "--preserveWatchOutput",
    ]);
    expect(processes.find((process: { name: string }) => process.name === "dev:admin")?.env).toMatchObject({
      HOST_API_PORT: "3002",
    });
  });

  it("is registered and documented", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const docs = readFileSync(new URL("../docs/operations.md", import.meta.url), "utf8");

    expect(pkg.scripts["dev:watch"]).toBe("node scripts/dev-watch.mjs");
    expect(docs).toContain("npm run dev:watch");
    expect(docs).toContain("local changes");
    expect(docs).toContain("without Docker image rebuilds");
  });
});
