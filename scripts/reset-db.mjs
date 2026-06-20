#!/usr/bin/env node
// Destroy the local Postgres volume and rebuild a fresh, migrated stack.
// Use when migrations are wedged or you want a clean database. Destructive:
// all local job data is lost.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEnvFile } from "./preflight.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd: rootDir, stdio: "inherit", ...options });
}

const env = parseEnvFile(`${rootDir}.env`);
const hostDbUrl = (env.DATABASE_URL ?? "postgres://ticket_to_pr:ticket_to_pr@localhost:5432/ticket_to_pr").replace(/@postgres:/, "@localhost:");

console.log("Resetting local database (this wipes all local job data)...\n");
run("docker", ["compose", "down", "-v"]);
run("docker", ["compose", "up", "-d", "--wait", "postgres", "redis"]);
run("npm", ["--workspace", "@ticket-to-pr/db", "run", "migrate"], { env: { ...process.env, DATABASE_URL: hostDbUrl } });
run("docker", ["compose", "up", "-d", "--build", "--wait", "api", "worker"]);
console.log("\n✓ Database reset and stack restarted.");
