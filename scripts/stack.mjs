#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  composeBaseArgs,
  composeProcessEnv,
  consumeEnvFileArgs,
  deriveComposeProjectName,
  displayEnvFile,
  resolveEnvFilePath,
  rootDir,
} from "./env-file.mjs";
import { parseEnvFile } from "./preflight.mjs";

function usage() {
  console.log("PatchPilot multi-env stack helper\n");
  console.log("Usage:");
  console.log("  npm run stack -- --env .env.github-a setup");
  console.log("  npm run stack -- --env .env.github-a up");
  console.log("  npm run stack -- --env .env.github-a status");
  console.log("  npm run stack -- --env .env.github-a logs");
  console.log("  npm run stack -- --env .env.github-a down");
  console.log("\nCommands: setup, doctor, up, status, logs, down, ps, build-runtime, refresh-runtime, reset-db");
  console.log("Unknown commands are passed through to `docker compose` for the selected env/project.");
}

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd: rootDir, stdio: "inherit", ...options });
}

export function resolveStackContext(argv = process.argv.slice(2), processEnv = process.env) {
  const parsed = consumeEnvFileArgs(argv);
  const action = parsed.rest[0] ?? "status";
  const actionArgs = parsed.rest.slice(1);
  const envPath = resolveEnvFilePath(parsed.envFile ?? processEnv.PATCHPILOT_ENV_FILE);
  const env = existsSync(envPath) ? parseEnvFile(envPath) : {};
  const projectEnv = processEnv.COMPOSE_PROJECT_NAME
    ? { ...env, COMPOSE_PROJECT_NAME: processEnv.COMPOSE_PROJECT_NAME }
    : env;
  const projectName = deriveComposeProjectName(envPath, projectEnv);
  const resolvedEnv = projectName ? { ...env, COMPOSE_PROJECT_NAME: projectName } : env;
  return {
    action,
    actionArgs,
    composeArgs: composeBaseArgs(envPath, resolvedEnv),
    env,
    envPath,
    processEnv: composeProcessEnv(envPath, resolvedEnv, processEnv),
    projectName,
  };
}

export function buildStackPlan(context) {
  const { action, actionArgs, composeArgs, envPath, processEnv } = context;
  switch (action) {
    case "-h":
    case "--help":
    case "help":
      return [];
    case "setup":
      return [{ command: "node", args: ["scripts/setup.mjs", "--env", displayEnvFile(envPath)], env: processEnv }];
    case "doctor":
      return [
        {
          command: "node",
          args: ["scripts/preflight.mjs", "--env", displayEnvFile(envPath), ...actionArgs],
          env: processEnv,
        },
      ];
    case "up":
      return [
        { command: "docker", args: [...composeArgs, "up", "-d", "--build", "--wait", ...actionArgs], env: processEnv },
      ];
    case "status":
      return [
        {
          command: "node",
          args: ["scripts/status.mjs", "--env", displayEnvFile(envPath), ...actionArgs],
          env: processEnv,
        },
      ];
    case "logs": {
      const targets = actionArgs.length > 0 ? actionArgs : ["api", "worker", "admin"];
      return [{ command: "docker", args: [...composeArgs, "logs", "-f", ...targets], env: processEnv }];
    }
    case "down":
      return [{ command: "docker", args: [...composeArgs, "down", ...actionArgs], env: processEnv }];
    case "ps":
      return [{ command: "docker", args: [...composeArgs, "ps", ...actionArgs], env: processEnv }];
    case "build-runtime":
      return [
        {
          command: "node",
          args: ["scripts/docker-build-runtime.mjs", "--env", displayEnvFile(envPath), ...actionArgs],
          env: processEnv,
        },
      ];
    case "refresh-runtime":
      return [
        {
          command: "node",
          args: ["scripts/docker-build-runtime.mjs", "--env", displayEnvFile(envPath)],
          env: processEnv,
        },
        { command: "docker", args: [...composeArgs, "up", "-d", "--force-recreate", "worker"], env: processEnv },
      ];
    case "reset-db":
      return [
        {
          command: "node",
          args: ["scripts/reset-db.mjs", "--env", displayEnvFile(envPath), ...actionArgs],
          env: processEnv,
        },
      ];
    default:
      return [{ command: "docker", args: [...composeArgs, action, ...actionArgs], env: processEnv }];
  }
}

function main() {
  const context = resolveStackContext();
  if (["-h", "--help", "help"].includes(context.action)) {
    usage();
    return;
  }

  console.log(`PatchPilot stack: ${displayEnvFile(context.envPath)}`);
  console.log(`Compose project: ${context.projectName || "(compose default)"}`);
  for (const step of buildStackPlan(context)) {
    run(step.command, step.args, { env: step.env });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`\nStack command failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
