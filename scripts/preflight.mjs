#!/usr/bin/env node
// Preflight checks for PatchPilot local setup. Validates the host toolchain and
// .env before the stack is started so misconfiguration fails fast and clearly,
// instead of surfacing as an opaque error mid-run.
//
// Usage:
//   node scripts/preflight.mjs            # validate against the modes in .env
//   node scripts/preflight.mjs --strict   # also fail on warnings
//   node scripts/preflight.mjs --quiet    # only print on failure
//
// Exit code 0 = ready, 1 = one or more hard failures.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { consumeEnvFileArgs, displayEnvFile, resolveEnvFilePath } from "./env-file.mjs";

const VALID_EXECUTOR_MODES = new Set(["mock", "gstack"]);
const VALID_PUBLISHER_MODES = new Set(["mock", "github"]);
export const requiredGstackSkills = ["patchpilot-ticket-runner", "gstack-autoplan", "gstack-review"];

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

export function hasRealRepositoryAllowlist(value) {
  return parseCsv(value).some((repository) => !isPlaceholder(repository) && /^[^/\s]+\/[^/\s]+$/.test(repository));
}

function parseCsv(value) {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function usesUnexpandedHome(value) {
  return /^~|\$HOME|\$\{HOME\}/.test(value);
}

// Real (gstack) runs mount Codex/gstack seed inputs into each runner container. .env is read
// WITHOUT shell expansion, so a `$HOME/...` (or `~/...`) value is taken literally and the mount
// silently resolves to nothing. Validate each mount so the failure surfaces here, not mid-run as
// an opaque "auth.json not found" inside the container. Returns { problems, warnings } messages.
export function checkRunnerMounts(env, { existsSync: exists = existsSync, readdirSync: readDir = readdirSync } = {}) {
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
      const message = `EXECUTOR_MODE=gstack requires ${key} — ${hint}.`;
      if (key === "CODEX_SKILLS_DIR") warnings.push(`${message} Run \`npm run setup\` to sync bundled skills.`);
      else problems.push(message);
      continue;
    }
    if (usesUnexpandedHome(value)) {
      warnings.push(`${key}="${value}" uses $HOME/~ which is NOT expanded in .env — use an absolute path (${hint}).`);
      continue;
    }
    if (!isAbsolute(value)) {
      warnings.push(`${key}="${value}" is relative; .env runner mounts should use an absolute path (${hint}).`);
      continue;
    }
    if (!exists(value)) {
      const message = `${key}="${value}" does not exist on this host — point it at a real ${kind} (${hint}).`;
      if (key === "CODEX_SKILLS_DIR") warnings.push(`${message} Run \`npm run setup\` to create and sync it.`);
      else problems.push(message);
    }
  }
  const skillsDir = env.CODEX_SKILLS_DIR;
  if (skillsDir && !usesUnexpandedHome(skillsDir) && isAbsolute(skillsDir) && exists(skillsDir)) {
    try {
      if (readDir(skillsDir).length === 0) {
        warnings.push(
          `CODEX_SKILLS_DIR="${skillsDir}" is empty; run \`npm run setup\` to install PatchPilot bundled skills before staged runs.`,
        );
      }
    } catch {
      // The existence check above already reported unusable paths where possible.
    }
  }
  const missingSkills = missingRequiredGstackSkills(env, { existsSync: exists });
  if (missingSkills.length > 0) {
    warnings.push(
      `CODEX_SKILLS_DIR is missing PatchPilot bundled skills (${missingSkills.join(", ")}). Run \`npm run setup\` to install them before staged runs.`,
    );
  }
  if (!env.GSTACK_COMMAND) {
    warnings.push("EXECUTOR_MODE=gstack but GSTACK_COMMAND is empty — the runner image must define the agent command.");
  }
  return { problems, warnings };
}

export function missingRequiredGstackSkills(env, { existsSync: exists = existsSync } = {}) {
  const root = env.CODEX_SKILLS_DIR;
  if (!root || usesUnexpandedHome(root) || !isAbsolute(root) || !exists(root)) return [];
  return requiredGstackSkills.filter((skill) => !exists(join(root, skill, "SKILL.md")));
}

export function resolvePreflightModes(env) {
  const problems = [];
  const executorMode = String(env.WORKER_EXECUTOR_MODE ?? env.EXECUTOR_MODE ?? "mock").toLowerCase();
  const rawPublisherMode = String(env.WORKER_PUBLISHER_MODE ?? env.PUBLISHER_MODE ?? "mock").toLowerCase();
  const publisherMode = rawPublisherMode === "gstack" ? "github" : rawPublisherMode;

  if (!VALID_EXECUTOR_MODES.has(executorMode)) {
    const hint =
      executorMode === "staged"
        ? "Use EXECUTOR_MODE=gstack; staged is selected per ticket via the staged runner path, not as the worker mode."
        : "Use EXECUTOR_MODE=mock for local smoke runs or EXECUTOR_MODE=gstack for the real runner.";
    problems.push(`Invalid EXECUTOR_MODE="${executorMode}". ${hint}`);
  }

  if (!VALID_PUBLISHER_MODES.has(publisherMode)) {
    problems.push(
      'Invalid PUBLISHER_MODE="' + rawPublisherMode + '". Use PUBLISHER_MODE=mock or PUBLISHER_MODE=github.',
    );
  }

  return { executorMode, publisherMode, problems };
}

// Runs all preflight checks. Returns { problems, warnings, info } so callers can
// decide how to report; the CLI entrypoint below prints and sets the exit code.
export function runPreflightChecks(options = {}) {
  const problems = [];
  const warnings = [];
  const info = [];
  const fail = (message) => problems.push(message);
  const warn = (message) => warnings.push(message);
  const ok = (message) => info.push(message);

  // Toolchain
  const nodeMajor = Number.parseInt(process.versions.node.split(".", 1)[0] ?? "0", 10);
  if (nodeMajor >= 24) {
    ok(`Node.js ${process.version} satisfies .nvmrc`);
  } else {
    fail(
      `Node.js 24+ is required by .nvmrc, but this shell is running ${process.version}. Run \`nvm use\`, or install Homebrew node@24 and run \`PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run setup\`.`,
    );
  }
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
  const envPath = resolveEnvFilePath(options.envFile);
  if (!existsSync(envPath)) {
    warn(`${displayEnvFile(envPath)} not found — setup will copy it from .env.example (mock-mode defaults).`);
    return { problems, warnings, info };
  }
  const env = { ...parseEnvFile(envPath), ...process.env };
  ok(`Environment file: ${displayEnvFile(envPath)}`);

  // Required for the API/worker to boot at all, in any mode.
  for (const key of ["ADMIN_TOKEN", "DATABASE_URL", "REDIS_URL", "LARK_WEBHOOK_SECRET"]) {
    if (!env[key]) fail(`Missing required env var: ${key}`);
  }
  if (env.ADMIN_TOKEN === "change-me-admin-token") {
    warn("ADMIN_TOKEN is still the default. Fine for local dev; change it before exposing the console.");
  }

  const modeCheck = resolvePreflightModes(env);
  const { executorMode, publisherMode } = modeCheck;
  for (const message of modeCheck.problems) fail(message);
  ok(`Executor mode: ${executorMode}, Publisher mode: ${publisherMode}`);

  // Real GitHub publishing requires real credentials and an allowlist.
  if (publisherMode === "github") {
    if (isPlaceholder(env.GITHUB_TOKEN)) fail("PUBLISHER_MODE=github requires a real GITHUB_TOKEN.");
    if (!hasRealRepositoryAllowlist(env.REPOSITORY_ALLOWLIST))
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

export function preflightExitCode(result, { strictWarnings = false } = {}) {
  if (result.problems.length > 0) return 1;
  if (strictWarnings && result.warnings.length > 0) return 1;
  return 0;
}

// CLI entrypoint — only runs when invoked directly, not when imported for parseEnvFile.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const parsedArgs = consumeEnvFileArgs(process.argv.slice(2));
  const quiet = parsedArgs.rest.includes("--quiet");
  const strict = parsedArgs.rest.includes("--strict") || parsedArgs.rest.includes("--strict-warnings");
  const { problems, warnings, info } = runPreflightChecks({ envFile: parsedArgs.envFile });

  const exitCode = preflightExitCode({ problems, warnings, info }, { strictWarnings: strict });

  if (!quiet || exitCode !== 0) {
    for (const line of info) console.log(`  ✓ ${line}`);
    for (const line of warnings) console.warn(`  ! ${line}`);
    for (const line of problems) console.error(`  ✗ ${line}`);
  }

  if (problems.length > 0) {
    console.error(`\nPreflight failed with ${problems.length} problem(s). Fix the above and retry.`);
    process.exit(1);
  } else if (strict && warnings.length > 0) {
    console.error(`\nPreflight failed with ${warnings.length} warning(s) under --strict. Fix the above and retry.`);
    process.exit(1);
  } else if (!quiet) {
    console.log("\nPreflight passed.");
  }
}
