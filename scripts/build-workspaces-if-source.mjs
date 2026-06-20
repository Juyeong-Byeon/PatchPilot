import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

const workspaces = new Map([
  ["@ticket-to-pr/core", "packages/core"],
  ["@ticket-to-pr/db", "packages/db"],
  ["@ticket-to-pr/queue", "packages/queue"],
  ["@ticket-to-pr/runner-contract", "packages/runner-contract"],
  ["@ticket-to-pr/api", "apps/api"],
  ["@ticket-to-pr/worker", "apps/worker"],
  ["@ticket-to-pr/runner", "apps/runner"],
  ["@ticket-to-pr/admin", "apps/admin"],
]);

const requestedWorkspaces = process.argv.slice(2);
const selectedWorkspaces = requestedWorkspaces.length > 0 ? requestedWorkspaces : [...workspaces.keys()];

for (const workspaceName of selectedWorkspaces) {
  const workspaceDir = workspaces.get(workspaceName);

  if (!workspaceDir) {
    throw new Error(`Unknown workspace: ${workspaceName}`);
  }

  if (!hasSourceFiles(path.join(rootDir, workspaceDir, "src"))) {
    console.log(`Skipping ${workspaceName}: no source files yet`);
    continue;
  }

  execFileSync("npm", ["--workspace", workspaceName, "run", "build"], {
    cwd: rootDir,
    stdio: "inherit",
  });
}

function hasSourceFiles(srcDir) {
  if (!existsSync(srcDir)) {
    return false;
  }

  const entries = readdirSync(srcDir);

  for (const entry of entries) {
    const entryPath = path.join(srcDir, entry);
    const stats = statSync(entryPath);

    if (stats.isDirectory() && hasSourceFiles(entryPath)) {
      return true;
    }

    if (stats.isFile() && isSourceFile(entryPath)) {
      return true;
    }
  }

  return false;
}

function isSourceFile(filePath) {
  return (
    (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) &&
    !filePath.endsWith(".test.ts") &&
    !filePath.endsWith(".test.tsx")
  );
}
