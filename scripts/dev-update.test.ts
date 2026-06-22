import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error — plain .mjs script, no type declarations.
import { buildDevUpdatePlan, devServerCommands, hostDatabaseUrl } from "./dev-update.mjs";

describe("dev-update script", () => {
  it("rewrites the Docker postgres hostname for host-run migrations", () => {
    expect(hostDatabaseUrl({ DATABASE_URL: "postgres://ticket_to_pr:ticket_to_pr@postgres:5432/ticket_to_pr" })).toBe(
      "postgres://ticket_to_pr:ticket_to_pr@localhost:5432/ticket_to_pr",
    );
  });

  it("plans a source-refresh workflow without rebuilding Docker app images", () => {
    const plan = buildDevUpdatePlan({ DATABASE_URL: "postgres://u:p@postgres:5432/ticket_to_pr" });

    expect(plan.map((step: { command: string; args: string[] }) => [step.command, step.args])).toEqual([
      ["git", ["fetch", "origin"]],
      ["git", ["pull", "--ff-only"]],
      ["npm", ["install"]],
      ["docker", ["compose", "up", "-d", "--wait", "postgres", "redis"]],
      ["npm", ["--workspace", "@ticket-to-pr/db", "run", "migrate"]],
      ["npm", ["run", "build"]],
    ]);
    expect(JSON.stringify(plan)).not.toContain("--build");
  });

  it("points developers at the one-command watch loop", () => {
    expect(devServerCommands({ HOST_API_PORT: "3002" })).toEqual(["npm run dev:watch"]);
  });

  it("is registered in package scripts", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts["dev:update"]).toBe("node scripts/dev-update.mjs");
  });

  it("documents the development update workflow", () => {
    const docs = readFileSync(new URL("../docs/operations.md", import.meta.url), "utf8");
    expect(docs).toContain("npm run dev:update");
    expect(docs).toContain("does not rebuild API/worker Docker images");
  });
});
