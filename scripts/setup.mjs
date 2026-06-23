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
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  composeBaseArgs,
  composeProcessEnv,
  consumeEnvFileArgs,
  displayEnvFile,
  resolveEnvFilePath,
} from "./env-file.mjs";
import { parseEnvFile } from "./preflight.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
export const bundledCodexSkills = ["patchpilot-ticket-runner", "gstack-autoplan", "gstack-review"];
let step = 0;

function heading(title) {
  step += 1;
  console.log(`\n[1m[${step}] ${title}[0m`);
}

function run(command, args, options = {}) {
  console.log(`    $ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd: rootDir, stdio: "inherit", ...options });
}

function runCompose(envPath, env, args) {
  run("docker", [...composeBaseArgs(envPath, env), ...args], { env: composeProcessEnv(envPath, env) });
}

export function hostDatabaseUrl(env) {
  const url = env.DATABASE_URL ?? "postgres://ticket_to_pr:ticket_to_pr@localhost:5432/ticket_to_pr";
  // Rewrite the in-container service hostname to localhost for host-run migration.
  return url.replace(/@postgres:/, "@localhost:");
}

export function setEnvValue(source, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${escapeRegExp(key)}=.*$`, "m");
  if (pattern.test(source)) return source.replace(pattern, line);
  return `${source.replace(/\s*$/, "")}\n${line}\n`;
}

export async function planFreshEnvPortUpdates(env, isPortAvailableFn = isPortAvailable) {
  const updates = {};
  const apiPort = parsePort(env.HOST_API_PORT, 3000);
  const adminPort = parsePort(env.HOST_ADMIN_PORT, 5173);

  if (!(await isPortAvailableFn(apiPort))) {
    const replacement = await firstAvailablePort(apiPort + 1, isPortAvailableFn);
    updates.HOST_API_PORT = String(replacement);
    if (!env.PUBLIC_BASE_URL || env.PUBLIC_BASE_URL === `http://localhost:${apiPort}`) {
      updates.PUBLIC_BASE_URL = `http://localhost:${replacement}`;
    }
  }

  if (!(await isPortAvailableFn(adminPort))) {
    updates.HOST_ADMIN_PORT = String(await firstAvailablePort(adminPort + 1, isPortAvailableFn));
  }

  return updates;
}

async function applyFreshEnvPortUpdates(envPath, env) {
  const updates = await planFreshEnvPortUpdates(env);
  if (Object.keys(updates).length === 0) return env;

  let source = readFileSync(envPath, "utf8");
  for (const [key, value] of Object.entries(updates)) {
    source = setEnvValue(source, key, value);
  }
  writeFileSync(envPath, source);
  for (const [key, value] of Object.entries(updates)) {
    console.log(`    ${key}=${value} (auto-selected because the default port was busy)`);
  }
  return { ...env, ...updates };
}

function parsePort(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function firstAvailablePort(startPort, isPortAvailableFn, attempts = 50) {
  for (let port = startPort; port < startPort + attempts; port += 1) {
    if (await isPortAvailableFn(port)) return port;
  }
  throw new Error(`Could not find a free port from ${startPort} to ${startPort + attempts - 1}`);
}

export function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "0.0.0.0");
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isGstackExecutor(env) {
  return String(env.WORKER_EXECUTOR_MODE ?? env.EXECUTOR_MODE ?? "mock").toLowerCase() === "gstack";
}

export function installBundledCodexSkills(env, options = {}) {
  const destinationRoot = env.CODEX_SKILLS_DIR;
  if (!destinationRoot) return { installed: [], skipped: bundledCodexSkills, reason: "missing CODEX_SKILLS_DIR" };
  if (/^~|\$HOME|\$\{HOME\}/.test(destinationRoot) || !isAbsolute(destinationRoot)) {
    return { installed: [], skipped: bundledCodexSkills, reason: "CODEX_SKILLS_DIR must be an absolute path" };
  }

  const sourceRoot = options.sourceRoot ?? join(rootDir, "apps", "runner", "skills");
  const skills = options.skills ?? bundledCodexSkills;
  mkdirSync(destinationRoot, { recursive: true });

  const installed = [];
  for (const skill of skills) {
    const source = join(sourceRoot, skill);
    if (!existsSync(join(source, "SKILL.md"))) throw new Error(`Bundled Codex skill is missing: ${source}`);
    const destination = join(destinationRoot, skill);
    rmSync(destination, { recursive: true, force: true });
    cpSync(source, destination, { recursive: true });
    installed.push(skill);
  }

  return { installed, skipped: [], reason: "" };
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
  const parsedArgs = consumeEnvFileArgs(process.argv.slice(2));
  const envPath = resolveEnvFilePath(parsedArgs.envFile);
  console.log("PatchPilot local setup\n======================");
  console.log(`Environment file: ${displayEnvFile(envPath)}`);

  heading("Preflight checks");
  run("node", ["scripts/preflight.mjs", "--env", displayEnvFile(envPath)]);

  heading("Environment file");
  let createdEnv = false;
  if (existsSync(envPath)) {
    console.log(`    ${displayEnvFile(envPath)} already exists — leaving it untouched.`);
  } else {
    copyFileSync(`${rootDir}.env.example`, envPath);
    createdEnv = true;
    console.log(`    Created ${displayEnvFile(envPath)} from .env.example (mock-mode defaults).`);
  }
  let env = parseEnvFile(envPath);
  if (createdEnv) {
    env = await applyFreshEnvPortUpdates(envPath, env);
  }

  if (isGstackExecutor(env)) {
    heading("Install bundled Codex skills");
    const result = installBundledCodexSkills(env);
    if (result.installed.length > 0) {
      console.log(`    Synced ${result.installed.join(", ")} into ${env.CODEX_SKILLS_DIR}`);
    } else {
      console.warn(`    Skipped bundled skill install: ${result.reason}`);
    }
  }

  heading("Install dependencies");
  run("npm", ["install"]);

  heading("Start Postgres and Redis");
  runCompose(envPath, env, ["up", "-d", "--wait", "postgres", "redis"]);

  heading("Run database migrations (host URL)");
  run("npm", ["run", "db:migrate"], {
    env: { ...process.env, DATABASE_URL: hostDatabaseUrl(env) },
  });

  if (isGstackExecutor(env)) {
    heading("Build runner runtime image");
    run("npm", ["run", "docker:build-runtime"], { env: composeProcessEnv(envPath, env) });
  }

  heading("Build and start API + worker + admin frontend");
  runCompose(envPath, env, ["up", "-d", "--build", "--wait", "api", "worker", "admin"]);

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
  console.log(`    npm run stack -- --env ${displayEnvFile(envPath)} status`);
  console.log("    npm run docker:frontend # rebuild/restart only the admin frontend");
  console.log("    npm run reset:db   # wipe the database volume and re-migrate");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`\n[31mSetup failed:[0m ${error instanceof Error ? error.message : error}`);
    console.error("Inspect logs with: npm run logs");
    process.exit(1);
  });
}
