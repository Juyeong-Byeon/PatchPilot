#!/usr/bin/env node
// Preflight checks for PatchPilot local setup. Validates the host toolchain and
// .env before the stack is started so misconfiguration fails fast and clearly,
// instead of surfacing as an opaque error mid-run.
//
// Usage:
//   node scripts/preflight.mjs            # validate against the modes in .env
//   node scripts/preflight.mjs --quiet    # only print on failure
//
// Exit code 0 = ready, 1 = one or more hard failures.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

export function parseEnvFile(path) {
  const env = {};
  if (!existsSync(path)) return env;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return env;
}

function isPlaceholder(value) {
  if (!value) return true;
  return /change-me|xxx|owner\/repo|^secret_|^cli_|^base_app_token|^table_|github_pat_xxx/i.test(value);
}

// Runs all preflight checks. Returns { problems, warnings, info } so callers can
// decide how to report; the CLI entrypoint below prints and sets the exit code.
export function runPreflightChecks() {
  const problems = [];
  const warnings = [];
  const info = [];
  const fail = (message) => problems.push(message);
  const warn = (message) => warnings.push(message);
  const ok = (message) => info.push(message);

  // Toolchain. On Windows, docker is resolved through a shell (.exe/.cmd shims).
  const useShell = process.platform === "win32";
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", shell: useShell });
    ok("Docker daemon is running");
  } catch {
    fail("Docker daemon is not reachable. Start Docker Desktop (or the docker service) and retry.");
  }
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore", shell: useShell });
    ok("Docker Compose v2 is available");
  } catch {
    fail("`docker compose` is not available. Install Docker Compose v2.");
  }

  // Environment
  const envPath = `${rootDir}.env`;
  if (!existsSync(envPath)) {
    warn(".env not found — setup will copy it from .env.example (mock-mode defaults).");
    return { problems, warnings, info };
  }
  const env = { ...parseEnvFile(envPath), ...process.env };

  // Required for the API/worker to boot at all, in any mode.
  for (const key of ["ADMIN_TOKEN", "DATABASE_URL", "REDIS_URL", "LARK_WEBHOOK_SECRET"]) {
    if (!env[key]) fail(`Missing required env var: ${key}`);
  }
  if (env.ADMIN_TOKEN === "change-me-admin-token") {
    warn("ADMIN_TOKEN is still the default. Fine for local dev; change it before exposing the console.");
  }

  const executorMode = (env.WORKER_EXECUTOR_MODE ?? env.EXECUTOR_MODE ?? "mock").toLowerCase();
  const publisherMode = (env.WORKER_PUBLISHER_MODE ?? env.PUBLISHER_MODE ?? "mock").toLowerCase();
  ok(`Executor mode: ${executorMode}, Publisher mode: ${publisherMode}`);

  // Real GitHub publishing requires real credentials and an allowlist.
  if (publisherMode === "github") {
    if (isPlaceholder(env.GITHUB_TOKEN)) fail("PUBLISHER_MODE=github requires a real GITHUB_TOKEN.");
    if (isPlaceholder(env.REPOSITORY_ALLOWLIST)) fail("PUBLISHER_MODE=github requires REPOSITORY_ALLOWLIST set to a real owner/repo.");
  }
  if (executorMode === "gstack" && !env.GSTACK_COMMAND) {
    warn("EXECUTOR_MODE=gstack but GSTACK_COMMAND is empty — the runner image must define the agent command.");
  }

  return { problems, warnings, info };
}

// CLI entrypoint — only runs when invoked directly, not when imported for parseEnvFile.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const quiet = process.argv.includes("--quiet");
  const { problems, warnings, info } = runPreflightChecks();

  if (!quiet || problems.length > 0) {
    for (const line of info) console.log(`  ✓ ${line}`);
    for (const line of warnings) console.warn(`  ! ${line}`);
    for (const line of problems) console.error(`  ✗ ${line}`);
  }

  if (problems.length > 0) {
    console.error(`\nPreflight failed with ${problems.length} problem(s). Fix the above and retry.`);
    process.exit(1);
  } else if (!quiet) {
    console.log("\nPreflight passed.");
  }
}
