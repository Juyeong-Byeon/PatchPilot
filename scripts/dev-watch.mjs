#!/usr/bin/env node
// One-command host-run development loop. It keeps TypeScript dist outputs fresh
// and runs API/worker/admin from the checkout, so local source edits are reflected
// without rebuilding Docker app images.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnvFile } from "./preflight.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const wantsHelp = process.argv.includes("--help") || process.argv.includes("-h");

function usage() {
  console.log("PatchPilot dev watch - run host dev servers with TypeScript watch builds.\n");
  console.log("Usage:");
  console.log("  npm run dev:watch            # start infra, build once, then watch + serve");
  console.log("  npm run dev:watch -- --help  # show this message");
  console.log("\nThis command stops containerized api/worker services, keeps postgres/redis");
  console.log("running in Docker, and runs API/worker/admin from the local checkout.");
}

function run(command, args, options = {}) {
  console.log(`    $ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: rootDir, stdio: "inherit", ...options });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function serviceUrlToLocalhost(value, serviceName) {
  return value
    ?.replace(new RegExp(`@${serviceName}:`, "g"), "@localhost:")
    .replace(new RegExp(`//${serviceName}:`, "g"), "//localhost:");
}

export function hostDevelopmentEnv(env = {}) {
  const apiPort = env.DEV_API_PORT ?? env.HOST_API_PORT ?? env.PORT ?? "3000";
  return {
    ...env,
    DATABASE_URL: serviceUrlToLocalhost(env.DATABASE_URL, "postgres"),
    REDIS_URL: serviceUrlToLocalhost(env.REDIS_URL, "redis"),
    PORT: String(apiPort),
    HOST_API_PORT: String(apiPort),
  };
}

export function buildDevWatchSetupPlan() {
  return [
    { command: "docker", args: ["compose", "up", "-d", "--wait", "postgres", "redis"] },
    { command: "docker", args: ["compose", "stop", "api", "worker"] },
    { command: "npm", args: ["run", "build"] },
  ];
}

function watchBuild(name, workspace) {
  return {
    name,
    command: "npm",
    args: ["--workspace", workspace, "run", "build", "--", "--watch", "--preserveWatchOutput"],
  };
}

export function buildDevWatchProcesses(env = {}) {
  const hostEnv = hostDevelopmentEnv(env);
  return [
    watchBuild("watch:core", "@ticket-to-pr/core"),
    watchBuild("watch:db", "@ticket-to-pr/db"),
    watchBuild("watch:queue", "@ticket-to-pr/queue"),
    watchBuild("watch:runner-contract", "@ticket-to-pr/runner-contract"),
    watchBuild("watch:api", "@ticket-to-pr/api"),
    watchBuild("watch:worker", "@ticket-to-pr/worker"),
    watchBuild("watch:runner", "@ticket-to-pr/runner"),
    { name: "dev:api", command: "npm", args: ["--workspace", "@ticket-to-pr/api", "run", "dev"], env: hostEnv },
    { name: "dev:worker", command: "npm", args: ["--workspace", "@ticket-to-pr/worker", "run", "dev"], env: hostEnv },
    { name: "dev:admin", command: "npm", args: ["--workspace", "@ticket-to-pr/admin", "run", "dev"], env: hostEnv },
  ];
}

function spawnManaged(processSpec, baseEnv, children) {
  const child = spawn(processSpec.command, processSpec.args, {
    cwd: rootDir,
    stdio: "inherit",
    env: { ...baseEnv, ...processSpec.env },
  });
  children.add(child);
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (signal || code === 0) return;
    console.error(`\n${processSpec.name} exited with code ${code}. Stopping dev watch.`);
    shutdown(children, code ?? 1);
  });
}

function shutdown(children, exitCode = 0) {
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(exitCode), 250).unref();
}

async function main() {
  if (wantsHelp) {
    usage();
    return;
  }

  const envPath = `${rootDir}.env`;
  const env = existsSync(envPath) ? parseEnvFile(envPath) : {};
  const hostEnv = hostDevelopmentEnv(env);

  console.log("PatchPilot dev watch\n====================");
  for (const action of buildDevWatchSetupPlan()) {
    run(action.command, action.args);
  }

  console.log("\nStarting watch builds and host-run dev servers...");
  console.log(`  API/Admin port: ${hostEnv.PORT}`);
  const children = new Set();
  process.once("SIGINT", () => shutdown(children, 0));
  process.once("SIGTERM", () => shutdown(children, 0));

  for (const processSpec of buildDevWatchProcesses(env)) {
    console.log(`    [${processSpec.name}] ${processSpec.command} ${processSpec.args.join(" ")}`);
    spawnManaged(processSpec, process.env, children);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`\n\x1b[31mDev watch failed:\x1b[0m ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
