import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const tscBin = path.join(rootDir, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

const projects = [
  { name: "@ticket-to-pr/core", dir: "packages/core" },
  { name: "@ticket-to-pr/db", dir: "packages/db" },
  { name: "@ticket-to-pr/queue", dir: "packages/queue" },
  { name: "@ticket-to-pr/runner-contract", dir: "packages/runner-contract" },
  { name: "@ticket-to-pr/api", dir: "apps/api" },
  { name: "@ticket-to-pr/worker", dir: "apps/worker" },
  { name: "@ticket-to-pr/runner", dir: "apps/runner" },
  { name: "@ticket-to-pr/admin", dir: "apps/admin" }
];

let checkedCount = 0;

for (const project of projects) {
  if (!hasSourceFiles(path.join(rootDir, project.dir, "src"))) {
    console.log(`Skipping ${project.name}: no source files yet`);
    continue;
  }

  checkedCount += 1;
  execFileSync(tscBin, ["-p", path.join(project.dir, "tsconfig.json"), "--pretty", "false"], {
    cwd: rootDir,
    stdio: "inherit"
  });
}

if (checkedCount === 0) {
  console.log("No workspace source files found; skipping workspace typecheck.");
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
  return (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) && !filePath.endsWith(".test.ts") && !filePath.endsWith(".test.tsx");
}
