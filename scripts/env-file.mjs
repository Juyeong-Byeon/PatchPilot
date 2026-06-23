import { basename, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const rootDir = fileURLToPath(new URL("..", import.meta.url));

export function consumeEnvFileArgs(argv = []) {
  const rest = [];
  let envFile;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--env" || arg === "--env-file") {
      envFile = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--env=")) {
      envFile = arg.slice("--env=".length);
    } else if (arg.startsWith("--env-file=")) {
      envFile = arg.slice("--env-file=".length);
    } else {
      rest.push(arg);
    }
  }
  return { envFile, rest };
}

export function resolveEnvFilePath(envFile = process.env.PATCHPILOT_ENV_FILE, baseDir = rootDir) {
  const selected = envFile?.trim() || ".env";
  return isAbsolute(selected) ? selected : join(baseDir, selected);
}

export function displayEnvFile(envFilePath, baseDir = rootDir) {
  const rel = relative(baseDir, envFilePath);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : envFilePath;
}

export function deriveComposeProjectName(envFilePath, env = {}) {
  const explicit = env.COMPOSE_PROJECT_NAME?.trim();
  if (explicit) return explicit;

  const name = basename(envFilePath);
  if (name === ".env") return "";

  const suffix = name.replace(/^\.env\.?/, "") || name;
  const safe = suffix
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe ? `patchpilot-${safe}` : "";
}

export function composeBaseArgs(envFilePath, env = {}) {
  const args = ["compose", "--env-file", displayEnvFile(envFilePath)];
  const projectName = deriveComposeProjectName(envFilePath, env);
  if (projectName) args.push("-p", projectName);
  return args;
}

export function composeProcessEnv(envFilePath, env = {}, processEnv = process.env) {
  const projectName = deriveComposeProjectName(envFilePath, env);
  return {
    ...processEnv,
    PATCHPILOT_ENV_FILE: displayEnvFile(envFilePath),
    ...(projectName ? { COMPOSE_PROJECT_NAME: projectName } : {}),
  };
}
