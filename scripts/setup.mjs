#!/usr/bin/env node
// One-command local bootstrap for PatchPilot. Designed to be run by a human OR
// by an AI coding agent without prior knowledge of the stack:
//
//   npm run setup
//
// It is idempotent — safe to re-run. Steps:
//   1. Preflight (Docker + .env validation)
//   2. Create .env from .env.example if missing
//   3. Install npm dependencies
//   4. Start + wait for Postgres and Redis
//   5. Run database migrations using the HOST database URL (the @postgres
//      hostname only resolves inside containers; from the host shell it must be
//      @localhost — this is the #1 manual-setup footgun, handled automatically)
//   6. Build + start the API, worker, and Docker-managed admin frontend, waiting
//      for the API readiness probe
//   7. Print the console URL and admin token
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnvFile } from "./preflight.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
let step = 0;

function heading(title) {
  step += 1;
  console.log(`\n[1m[${step}] ${title}[0m`);
}

function run(command, args, options = {}) {
  console.log(`    $ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd: rootDir, stdio: "inherit", ...options });
}

function hostDatabaseUrl(env) {
  const url = env.DATABASE_URL ?? "postgres://ticket_to_pr:ticket_to_pr@localhost:5432/ticket_to_pr";
  // Rewrite the in-container service hostname to localhost for host-run migration.
  return url.replace(/@postgres:/, "@localhost:");
}

async function waitForReady(url, attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function main() {
  console.log("PatchPilot local setup\n======================");

  heading("Preflight checks");
  run("node", ["scripts/preflight.mjs"]);

  heading("Environment file");
  const envPath = `${rootDir}.env`;
  if (existsSync(envPath)) {
    console.log("    .env already exists — leaving it untouched.");
  } else {
    copyFileSync(`${rootDir}.env.example`, envPath);
    console.log("    Created .env from .env.example (mock-mode defaults).");
  }
  const env = parseEnvFile(envPath);

  heading("Install dependencies");
  run("npm", ["install"]);

  heading("Start Postgres and Redis");
  run("docker", ["compose", "up", "-d", "--wait", "postgres", "redis"]);

  heading("Run database migrations (host URL)");
  run("npm", ["--workspace", "@ticket-to-pr/db", "run", "migrate"], {
    env: { ...process.env, DATABASE_URL: hostDatabaseUrl(env) },
  });

  heading("Build and start API + worker + admin frontend");
  run("docker", ["compose", "up", "-d", "--build", "--wait", "api", "worker", "admin"]);

  heading("Verify readiness");
  const apiPort = env.HOST_API_PORT ?? process.env.HOST_API_PORT ?? "3000";
  const adminPort = env.HOST_ADMIN_PORT ?? process.env.HOST_ADMIN_PORT ?? "5173";
  const ready = await waitForReady(`http://localhost:${apiPort}/api/ready`);
  if (!ready) {
    console.error("    API did not become ready. Check logs with: npm run logs");
    process.exit(1);
  }
  console.log("    API is ready.");

  console.log("\n[32m✓ Setup complete.[0m");
  console.log(`\n  Admin console : http://localhost:${adminPort}`);
  console.log(`  API base      : http://localhost:${apiPort}`);
  console.log(`  Admin token   : ${env.ADMIN_TOKEN ?? "(see .env ADMIN_TOKEN)"}`);
  console.log("\n  Useful commands:");
  console.log("    npm run logs       # tail api + worker + admin logs");
  console.log("    npm run status     # show container + readiness state");
  console.log("    npm run down       # stop the stack");
  console.log("    npm run docker:frontend # rebuild/restart only the admin frontend");
  console.log("    npm run reset:db   # wipe the database volume and re-migrate");
}

main().catch((error) => {
  console.error(`\n[31mSetup failed:[0m ${error instanceof Error ? error.message : error}`);
  console.error("Inspect logs with: npm run logs");
  process.exit(1);
});
