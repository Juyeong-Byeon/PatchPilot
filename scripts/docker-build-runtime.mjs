#!/usr/bin/env node
// Build the worker and runner images, stamping each with a `git-sha` label set
// to the current HEAD commit. The stale-image guard (scripts/status.mjs) reads
// that label from the running worker image and warns (or, in --strict, fails)
// when it drifts from HEAD — institutionalizing the "rebuild after worker/runner
// changes" lesson so a stale image can't silently run old code.
//
// Equivalent to the previous inline npm script
//   docker compose --profile build build worker runner-image
// plus the build-arg/override that injects GIT_SHA into the image labels.
//
// Usage: node scripts/docker-build-runtime.mjs   (via `npm run docker:build-runtime`)
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

function gitHead() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir }).toString("utf8").trim();
  } catch {
    // Not a git checkout (e.g. a tarball export) — build without a SHA label.
    // The guard treats a missing label as "unknown" and warns rather than crashes.
    return "";
  }
}

const gitSha = gitHead();
if (gitSha) {
  console.log(`[docker:build-runtime] Stamping worker/runner images with git-sha=${gitSha}`);
} else {
  console.warn("[docker:build-runtime] Could not resolve git HEAD — images will have an empty git-sha label.");
}

execFileSync(
  "docker",
  [
    "compose",
    "-f",
    "docker-compose.yml",
    "-f",
    "docker/compose.build.yml",
    "--profile",
    "build",
    "build",
    "worker",
    "runner-image",
  ],
  {
    cwd: rootDir,
    stdio: "inherit",
    env: { ...process.env, GIT_SHA: gitSha },
  },
);
