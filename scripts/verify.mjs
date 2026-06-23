#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

export function buildVerifyPlan() {
  return [
    { title: "Check formatting", command: "npm", args: ["run", "format:check"] },
    { title: "Typecheck workspaces", command: "npm", args: ["run", "typecheck"] },
    { title: "Lint", command: "npm", args: ["run", "lint"] },
    { title: "Build", command: "npm", args: ["run", "build"] },
    { title: "Run tests", command: "npm", args: ["test"] },
    { title: "Scan secrets", command: "npm", args: ["run", "scan:secrets"] },
  ];
}

function usageText() {
  return [
    "PatchPilot local verification.",
    "",
    "Usage:",
    "  npm run verify           # format, typecheck, lint, test, build, scan secrets",
    "  npm run verify -- --help # show this message",
    "",
    "This intentionally skips e2e:smoke because it requires an already-running mock stack.",
  ].join("\n");
}

function run(command, args) {
  console.log(`    $ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd: rootDir, stdio: "inherit" });
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usageText());
    return;
  }

  console.log("PatchPilot verify\n=================");
  let index = 0;
  for (const step of buildVerifyPlan()) {
    index += 1;
    console.log(`\n\x1b[1m[${index}] ${step.title}\x1b[0m`);
    run(step.command, step.args);
  }
  console.log("\n\x1b[32m✓ Verify complete.\x1b[0m");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`\n\x1b[31mVerify failed:\x1b[0m ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
