#!/usr/bin/env node
// Resolve the build's version + commit SHA so they can be stamped into the images
// (as the APP_VERSION / GIT_SHA build args). GET /api/version reads them back, and
// the admin's bottom-left VersionBadge shows them, so operators can confirm exactly
// which build is serving.
//
// Version comes from the latest git tag — i.e. the most recent semantic-release
// release (see .releaserc.json) — with the leading "v" stripped. Before the first
// release (or in a shallow clone with no tags) it falls back to the root
// package.json version. SHA is the full HEAD commit, or "" outside a git checkout.
//
// Usage:
//   import { resolveBuildStamp } from "./build-stamp.mjs"  // { version, sha }
//   node scripts/build-stamp.mjs                            // prints APP_VERSION=… / GIT_SHA=…
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

// Run a git command, returning trimmed stdout or "" on any failure (e.g. no tags
// yet, or not a git checkout). git's own stderr is suppressed so the caller stays quiet.
function tryGit(args) {
  try {
    return execFileSync("git", args, { cwd: rootDir, stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf8")
      .trim();
  } catch {
    return "";
  }
}

function packageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" && pkg.version.trim() !== "" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function resolveBuildStamp() {
  const sha = tryGit(["rev-parse", "HEAD"]);
  const tag = tryGit(["describe", "--tags", "--abbrev=0"]).replace(/^v/, "");
  return { version: tag !== "" ? tag : packageVersion(), sha };
}

// When invoked directly, print KEY=VALUE lines so a shell can `eval`/export them.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { version, sha } = resolveBuildStamp();
  console.log(`APP_VERSION=${version}`);
  console.log(`GIT_SHA=${sha}`);
}
