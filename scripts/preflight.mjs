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

// Real (gstack) runs mount Codex/gstack seed inputs into each runner container. .env is read
// WITHOUT shell expansion, so a `$HOME/...` (or `~/...`) value is taken literally and the mount
// silently resolves to nothing. Validate each mount so the failure surfaces here, not mid-run as
// an opaque "auth.json not found" inside the container. Returns { problems, warnings } messages.
export function checkRunnerMounts(env, { existsSync: exists = existsSync } = {}) {
  const problems = [];
  const warnings = [];
  const mounts = [
    { key: "CODEX_AUTH_FILE", kind: "file", hint: "Codex auth (e.g. /Users/you/.codex/auth.json)" },
    { key: "CODEX_CONFIG_FILE", kind: "file", hint: "Codex config (e.g. /Users/you/.codex/config.toml)" },
    { key: "CODEX_SKILLS_DIR", kind: "dir", hint: "Codex skills directory (e.g. /Users/you/.codex/skills)" },
    { key: "GSTACK_SKILL_SOURCE_DIR", kind: "dir", hint: "gstack checkout root (e.g. /Users/you/gstack)" },
  ];
  for (const { key, kind, hint } of mounts) {
    const value = env[key];
    if (!value) {
      problems.push(`EXECUTOR_MODE=gstack requires ${key} — ${hint}.`);
      continue;
    }
    if (/^~|\$HOME|\$\{HOME\}/.test(value)) {
      warnings.push(`${key}="${value}" uses $HOME/~ which is NOT expanded in .env — use an absolute path (${hint}).`);
      continue;
    }
    if (!exists(value)) {
      problems.push(`${key}="${value}" does not exist on this host — point it at a real ${kind} (${hint}).`);
    }
  }
  if (!env.GSTACK_COMMAND) {
    warnings.push("EXECUTOR_MODE=gstack but GSTACK_COMMAND is empty — the runner image must define the agent command.");
  }
  return { problems, warnings };
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

  // Toolchain
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    ok("Docker daemon is running");
  } catch {
    fail("Docker daemon is not reachable. Start Docker Desktop (or the docker service) and retry.");
  }
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
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
    if (isPlaceholder(env.REPOSITORY_ALLOWLIST))
      fail("PUBLISHER_MODE=github requires REPOSITORY_ALLOWLIST set to a real owner/repo.");
  }
  // Real-mode runner mounts: only meaningful for the gstack executor. Validates that the
  // Codex/gstack seed paths resolve and warns when a non-expanding $HOME slipped into .env.
  if (executorMode === "gstack") {
    const mountCheck = checkRunnerMounts(env);
    for (const message of mountCheck.problems) fail(message);
    for (const message of mountCheck.warnings) warn(message);
    if (mountCheck.problems.length === 0 && mountCheck.warnings.length === 0) {
      ok("Codex/gstack runner mounts resolve");
    }
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
