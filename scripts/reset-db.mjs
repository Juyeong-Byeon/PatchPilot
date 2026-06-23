#!/usr/bin/env node
// Destroy the local Postgres volume and rebuild a fresh, migrated stack.
// Use when migrations are wedged or you want a clean database. Destructive:
// all local job data is lost.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { composeBaseArgs, composeProcessEnv, consumeEnvFileArgs, resolveEnvFilePath } from "./env-file.mjs";
import { parseEnvFile } from "./preflight.mjs";
import { resolveBuildStamp } from "./build-stamp.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const parsedArgs = consumeEnvFileArgs(process.argv.slice(2));
const envPath = resolveEnvFilePath(parsedArgs.envFile);

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd: rootDir, stdio: "inherit", ...options });
}

const env = parseEnvFile(envPath);
const composeArgs = composeBaseArgs(envPath, env);
const childEnv = composeProcessEnv(envPath, env);
const hostDbUrl = (env.DATABASE_URL ?? "postgres://ticket_to_pr:ticket_to_pr@localhost:5432/ticket_to_pr").replace(
  /@postgres:/,
  "@localhost:",
);

console.log("Resetting local database (this wipes all local job data)...\n");
run("docker", [...composeArgs, "down", "-v"], { env: childEnv });
run("docker", [...composeArgs, "up", "-d", "--wait", "postgres", "redis"], { env: childEnv });
run("npm", ["--workspace", "@ticket-to-pr/db", "run", "migrate"], { env: { ...process.env, DATABASE_URL: hostDbUrl } });
// Stamp the freshly built api image with the version + commit so GET /api/version
// (and the admin's bottom-left VersionBadge) report exactly what is running.
const stamp = resolveBuildStamp();
run("docker", [...composeArgs, "up", "-d", "--build", "--wait", "api", "worker"], {
  env: { ...childEnv, APP_VERSION: stamp.version, GIT_SHA: stamp.sha },
});
console.log("\n✓ Database reset and stack restarted.");
