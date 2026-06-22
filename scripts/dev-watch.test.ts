import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error — plain .mjs script, no type declarations.
import { buildDevWatchProcesses, buildDevWatchSetupPlan, hostDevelopmentEnv } from "./dev-watch.mjs";

describe("dev-watch script", () => {
  it("prepares infra and a Docker-managed frontend without rebuilding API/worker images", () => {
    const plan = buildDevWatchSetupPlan({ HOST_API_PORT: "3002" });

    expect(plan.map((step: { command: string; args: string[] }) => [step.command, step.args])).toEqual([
      ["docker", ["compose", "up", "-d", "--wait", "postgres", "redis"]],
      ["docker", ["compose", "stop", "api", "worker"]],
      ["npm", ["run", "build"]],
      ["docker", ["compose", "up", "-d", "--build", "admin"]],
    ]);
    expect(plan).not.toContainEqual(expect.objectContaining({ args: expect.arrayContaining(["--build", "api"]) }));
    expect(plan).not.toContainEqual(expect.objectContaining({ args: expect.arrayContaining(["--build", "worker"]) }));
    expect(plan.at(-1)?.env).toMatchObject({
      VITE_ADMIN_API_BASE_URL: "http://host.docker.internal:3002",
    });
  });

  it("treats a blank admin API base URL as unset in dev watch", () => {
    const plan = buildDevWatchSetupPlan({ HOST_API_PORT: "3002", VITE_ADMIN_API_BASE_URL: "" });

    expect(plan.at(-1)?.env).toMatchObject({
      VITE_ADMIN_API_BASE_URL: "http://host.docker.internal:3002",
    });
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

  it("runs TypeScript watchers plus host API and worker dev servers", () => {
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
    expect(processes.map((process: { name: string }) => process.name)).not.toContain("dev:admin");
  });

  it("is registered and documented", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const docs = readFileSync(new URL("../docs/operations.md", import.meta.url), "utf8");

    expect(pkg.scripts["dev:watch"]).toBe("node scripts/dev-watch.mjs");
    expect(pkg.scripts["docker:frontend"]).toBe("docker compose up -d --build admin");
    expect(pkg.scripts["logs"]).toBe("docker compose logs -f api worker admin");
    expect(docs).toContain("npm run dev:watch");
    expect(docs).toContain("Docker-managed frontend");
    expect(docs).toContain("local changes");
    expect(docs).toContain("without Docker image rebuilds");
  });
});
