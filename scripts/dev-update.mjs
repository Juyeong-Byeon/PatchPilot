#!/usr/bin/env node
// Development update command for host-run PatchPilot development.
// It refreshes source/dependencies/DB/local dist outputs without rebuilding the
// API or worker Docker images. Use production `npm run update -- --apply` when
// Docker image refresh is the desired deployment behavior.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnvFile } from "./preflight.mjs";

export const DEFAULT_DATABASE_URL = "postgres://ticket_to_pr:ticket_to_pr@localhost:5432/ticket_to_pr";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const wantsHelp = process.argv.includes("--help") || process.argv.includes("-h");
let step = 0;

function usage() {
  console.log("PatchPilot dev update - pull current branch and refresh host-run development state.\n");
  console.log("Usage:");
  console.log("  npm run dev:update            # pull, install, start infra, migrate, build");
  console.log("  npm run dev:update -- --help  # show this message");
  console.log("\nThis command does not rebuild API/worker Docker images. Use it for development");
  console.log("when API/worker/admin processes run from the host checkout.");
}

function heading(title) {
  step += 1;
  console.log(`\n\x1b[1m[${step}] ${title}\x1b[0m`);
}

function run(command, args, options = {}) {
  console.log(`    $ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd: rootDir, stdio: "inherit", ...options });
}

function capture(command, args, what) {
  try {
    return execFileSync(command, args, { cwd: rootDir }).toString("utf8").trim();
  } catch (error) {
    throw new Error(`${what} failed: ${error instanceof Error ? error.message : error}`);
  }
}

function fail(message) {
  console.error(`\n\x1b[31mDev update failed:\x1b[0m ${message}`);
  process.exit(1);
}

export function hostDatabaseUrl(env) {
  const url = env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  return url.replace(/@postgres:/, "@localhost:");
}

export function buildDevUpdatePlan(env = {}) {
  return [
    { title: "Fetch latest refs", command: "git", args: ["fetch", "origin"] },
    { title: "Fast-forward current branch", command: "git", args: ["pull", "--ff-only"] },
    { title: "Install dependencies", command: "npm", args: ["install"] },
    {
      title: "Start development infrastructure",
      command: "docker",
      args: ["compose", "up", "-d", "--wait", "postgres", "redis"],
    },
    {
      title: "Run database migrations",
      command: "npm",
      args: ["--workspace", "@ticket-to-pr/db", "run", "migrate"],
      env: { DATABASE_URL: hostDatabaseUrl(env) },
    },
    { title: "Build local workspace outputs", command: "npm", args: ["run", "build"] },
  ];
}

export function devServerCommands(_env = {}) {
  return ["npm run dev:watch"];
}

async function main() {
  if (wantsHelp) {
    usage();
    return;
  }

  console.log("PatchPilot dev update\n=====================");

  const dirty = capture("git", ["status", "--porcelain"], "Checking working tree state");
  if (dirty) {
    fail(
      "the working tree has uncommitted changes - refusing to pull.\n" +
        "  Commit, stash, or discard local changes, then re-run `npm run dev:update`.",
    );
  }

  const envPath = `${rootDir}.env`;
  const env = existsSync(envPath) ? parseEnvFile(envPath) : {};
  for (const action of buildDevUpdatePlan(env)) {
    heading(action.title);
    run(action.command, action.args, action.env ? { env: { ...process.env, ...action.env } } : undefined);
  }

  console.log("\n\x1b[32m✓ Dev update complete.\x1b[0m");
  console.log("\nStart host-run development servers in separate terminals:");
  for (const command of devServerCommands(env)) {
    console.log(`    ${command}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
