#!/usr/bin/env node
// Operational update command for operators running PatchPilot in production.
// Checks whether the deployed checkout is behind origin/main and, on request,
// fast-forwards and rebuilds/restarts the stack. Read-only by default — it only
// mutates the checkout or containers when invoked with --apply.
//
// Usage:
//   node scripts/update.mjs              # report only: fetch, compare HEAD vs origin/main, list incoming commits
//   node scripts/update.mjs --apply      # if clean & behind: git pull --ff-only, then docker compose up -d --build
//   node scripts/update.mjs --help       # show this usage
//
// Exit code 0 = up to date or report printed successfully; 1 = a hard failure
// (dirty tree under --apply, unresolved origin/main, or a failed shell call).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const apply = process.argv.includes("--apply");
const wantsHelp = process.argv.includes("--help") || process.argv.includes("-h");

function usage() {
  console.log("PatchPilot update — check whether the deployed checkout is behind origin/main, and optionally apply.\n");
  console.log("Usage:");
  console.log("  npm run update              # report only (no mutation): fetch and compare HEAD vs origin/main");
  console.log("  npm run update -- --apply  # fast-forward to origin/main, then rebuild + restart the stack");
  console.log("  npm run update -- --help   # show this message");
  console.log("\nThe report run never mutates the checkout or containers. --apply refuses to run on a dirty");
  console.log("working tree and fast-forwards ONLY (it never merges or rebases).");
}

// Echo + run a shell command with inherited stdio, matching the sibling scripts.
function run(command, args, options = {}) {
  console.log(`    $ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd: rootDir, stdio: "inherit", ...options });
}

// Capture a command's stdout as a trimmed string, or throw with a readable message.
function capture(command, args, what) {
  try {
    return execFileSync(command, args, { cwd: rootDir }).toString("utf8").trim();
  } catch (error) {
    throw new Error(`${what} failed: ${error instanceof Error ? error.message : error}`);
  }
}

function short(sha) {
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

function fail(message) {
  console.error(`\n\x1b[31mUpdate failed:\x1b[0m ${message}`);
  process.exit(1);
}

async function main() {
  if (wantsHelp) {
    usage();
    return;
  }

  console.log("\x1b[1mPatchPilot update\x1b[0m");

  // Resolve the current branch and HEAD up front so the report is informative.
  const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"], "Resolving current branch");
  const head = capture("git", ["rev-parse", "HEAD"], "Resolving HEAD");

  // Fetch origin so the comparison reflects the remote. This is read-only — it
  // updates remote-tracking refs but never touches the working tree.
  console.log("\nFetching origin (read-only)...");
  try {
    run("git", ["fetch", "origin"]);
  } catch (error) {
    fail(`could not fetch origin (no network or remote?): ${error instanceof Error ? error.message : error}`);
  }

  // origin/main must resolve, or there is nothing to compare against.
  let remoteHead;
  try {
    remoteHead = execFileSync("git", ["rev-parse", "origin/main"], { cwd: rootDir }).toString("utf8").trim();
  } catch {
    fail(
      "could not resolve origin/main — is the 'origin' remote configured and fetched? Check your network and `git remote -v`.",
    );
    return;
  }

  console.log(`\n  Current branch : ${branch}`);
  console.log(`  Local HEAD     : ${short(head)}`);
  console.log(`  origin/main    : ${short(remoteHead)}`);

  if (head === remoteHead) {
    console.log("\n\x1b[32m✓ Already up to date with origin/main.\x1b[0m");
    return;
  }

  // Count how many commits HEAD is behind origin/main.
  const behindCount = Number(capture("git", ["rev-list", "--count", "HEAD..origin/main"], "Counting incoming commits"));

  if (behindCount === 0) {
    // HEAD differs from origin/main but is not behind it (e.g. ahead or diverged).
    // Nothing to fast-forward; surface this rather than silently doing nothing.
    console.log("\n\x1b[32m✓ Not behind origin/main — no incoming commits to apply.\x1b[0m");
    console.log("  (HEAD differs from origin/main but is not strictly behind it; a fast-forward is not applicable.)");
    return;
  }

  const plural = behindCount === 1 ? "commit" : "commits";
  console.log(`\n  Behind by      : ${behindCount} ${plural}`);
  console.log("\nIncoming commits (HEAD..origin/main):");
  run("git", ["log", "--oneline", "HEAD..origin/main"]);

  if (!apply) {
    console.log(`\nThis checkout is ${behindCount} ${plural} behind origin/main.`);
    console.log("To fast-forward and rebuild/restart the stack, run:");
    console.log("    npm run update -- --apply");
    return;
  }

  // --- --apply path: mutate only after refusing on a dirty tree ---

  // Refuse to fast-forward over uncommitted local changes.
  const dirty = capture("git", ["status", "--porcelain"], "Checking working tree state");
  if (dirty) {
    fail(
      "the working tree has uncommitted changes — refusing to apply.\n" +
        "  Commit, stash, or discard local changes, then re-run `npm run update -- --apply`.\n" +
        "  (`git status` shows what changed.)",
    );
  }

  console.log("\nApplying update (fast-forward only)...");
  try {
    run("git", ["pull", "--ff-only", "origin", "main"]);
  } catch (error) {
    fail(`fast-forward pull failed: ${error instanceof Error ? error.message : error}`);
  }

  console.log("\nRebuilding and restarting the stack...");
  try {
    run("docker", ["compose", "up", "-d", "--build"]);
  } catch (error) {
    fail(`docker compose up failed: ${error instanceof Error ? error.message : error}`);
  }

  const newHead = capture("git", ["rev-parse", "HEAD"], "Resolving updated HEAD");
  console.log(`\n\x1b[32m✓ Update complete — now at ${short(newHead)}.\x1b[0m`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
