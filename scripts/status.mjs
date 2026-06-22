#!/usr/bin/env node
// Show the local stack state: container status, the API readiness probe, and a
// stale-image guard that catches a worker running on an image built from a
// different commit than the current checkout.
//
// Usage:
//   node scripts/status.mjs            # report status; stale image is a loud warning
//   node scripts/status.mjs --strict   # additionally exit non-zero on a stale/unknown image
//
// The stale-image guard institutionalizes the "rebuild worker/runner after
// source changes" lesson: images built via `npm run docker:build-runtime` carry
// a `git-sha` label (see scripts/docker-build-runtime.mjs). Here we read that
// label off the running worker image and compare it to `git rev-parse HEAD`.
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnvFile } from "./preflight.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

export function parseComposePsJsonLines(output) {
  const trimmed = output.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return trimmed
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

export function summarizeWorkerService(rows) {
  const worker = rows.find((row) => serviceName(row) === "worker");
  if (!worker) {
    return {
      ok: false,
      severity: "error",
      message: "worker service is not running or was not created by docker compose.",
    };
  }
  const state = String(worker.State ?? worker.state ?? worker.Status ?? worker.status ?? "").toLowerCase();
  if (!state.includes("running")) {
    return {
      ok: false,
      severity: "error",
      message: `worker service is ${state || "unknown"}, expected running.`,
    };
  }
  return { ok: true, severity: "ok", message: "worker service is running." };
}

export function statusExitCode(result, { strict = false } = {}) {
  if (!strict) return 0;
  return result.apiOk && result.adminOk && result.workerOk && result.staleImageOk ? 0 : 1;
}

function serviceName(row) {
  return String(row.Service ?? row.service ?? row.Name ?? row.name ?? "");
}

async function probeJson(url) {
  try {
    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    console.log(`  HTTP ${res.status} ${JSON.stringify(body)}`);
    return res.ok;
  } catch (error) {
    console.error(`  Unreachable: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

async function probeStatus(url) {
  try {
    const res = await fetch(url);
    console.log(`  HTTP ${res.status}`);
    return res.ok;
  } catch (error) {
    console.error(`  Unreachable: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

function readComposePsRows() {
  try {
    const out = execFileSync("docker", ["compose", "ps", "--format", "json"], { cwd: rootDir }).toString("utf8");
    return parseComposePsJsonLines(out);
  } catch {
    return [];
  }
}

async function main() {
  const strict = process.argv.includes("--strict");
  const env = parseEnvFile(`${rootDir}.env`);
  const port = env.HOST_API_PORT ?? process.env.HOST_API_PORT ?? "3000";
  const adminPort = env.HOST_ADMIN_PORT ?? process.env.HOST_ADMIN_PORT ?? "5173";

  console.log("Containers:");
  try {
    execFileSync("docker", ["compose", "ps"], { cwd: rootDir, stdio: "inherit" });
  } catch {
    console.error("  Could not read container state (is Docker running?).");
  }

  const rows = readComposePsRows();
  const workerSummary = summarizeWorkerService(rows);
  console.log("\nWorker service:");
  const workerPrefix = workerSummary.ok ? "✓" : "✗";
  console.log(`  ${workerPrefix} ${workerSummary.message}`);

  console.log(`\nAPI readiness (http://localhost:${port}/api/ready):`);
  const apiOk = await probeJson(`http://localhost:${port}/api/ready`);

  console.log(`\nAdmin frontend (http://localhost:${adminPort}):`);
  const adminOk = await probeStatus(`http://localhost:${adminPort}`);

  const staleImageOk = checkWorkerImageFreshness();
  const exitCode = statusExitCode({ adminOk, apiOk, staleImageOk, workerOk: workerSummary.ok }, { strict });
  if (exitCode !== 0) {
    console.error("\nStatus failed (--strict). Check the unhealthy item(s) above.");
    process.exit(exitCode);
  }
}

// Returns true when the running worker image matches HEAD (or when the check is
// inconclusive in non-strict mode and we only warn). Returns false on a
// confirmed mismatch or an unknown/missing label that --strict should reject.
function checkWorkerImageFreshness() {
  console.log("\nStale-image guard (worker image git-sha vs HEAD):");

  const head = gitHead();
  if (!head) {
    console.warn("  ! Could not resolve git HEAD — skipping stale-image check.");
    return true; // not a confirmed staleness; don't fail strict on a non-git checkout
  }

  const image = workerImageRef();
  if (!image) {
    console.warn("  ! Worker container/image not found (is the stack up?). Skipping stale-image check.");
    return true;
  }

  const label = imageGitShaLabel(image);
  if (label === null) {
    console.warn(`  ! Could not inspect image ${image} (is Docker running?). Skipping stale-image check.`);
    return true;
  }
  if (label === "") {
    console.warn(
      `  ! Worker image ${image} has no git-sha label.\n` +
        "    It was likely built without scripts/docker-build-runtime.mjs.\n" +
        "    Rebuild with: npm run docker:refresh-runtime",
    );
    return false;
  }

  if (label === head) {
    console.log(`  ✓ Worker image is current (git-sha=${short(head)}).`);
    return true;
  }

  console.warn(
    "  ! STALE WORKER IMAGE: the running worker was built from a different commit than your checkout.\n" +
      `      image git-sha : ${short(label)}\n` +
      `      current HEAD  : ${short(head)}\n` +
      "    The worker may be running OLD code. Rebuild and recreate with:\n" +
      "      npm run docker:refresh-runtime",
  );
  return false;
}

function gitHead() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir }).toString("utf8").trim();
  } catch {
    return "";
  }
}

// Resolve the image reference backing the worker service. Prefer the running
// container's image (what is actually executing); fall back to the configured
// compose image so the guard still works for a freshly built-but-not-started image.
function workerImageRef() {
  const containerImage = runningWorkerContainerImage();
  if (containerImage) return containerImage;
  return composeWorkerImage();
}

function runningWorkerContainerImage() {
  try {
    const id = execFileSync("docker", ["compose", "ps", "-q", "worker"], { cwd: rootDir })
      .toString("utf8")
      .trim()
      .split("\n")[0]
      ?.trim();
    if (!id) return "";
    return execFileSync("docker", ["inspect", "--format", "{{.Image}}", id], { cwd: rootDir }).toString("utf8").trim();
  } catch {
    return "";
  }
}

function composeWorkerImage() {
  try {
    // `docker compose images` prints the image associated with each service.
    const out = execFileSync("docker", ["compose", "images", "worker", "--format", "json"], {
      cwd: rootDir,
    })
      .toString("utf8")
      .trim();
    if (!out) return "";
    const parsed = JSON.parse(out);
    const row = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!row) return "";
    const repository = row.Repository ?? row.repository;
    const tag = row.Tag ?? row.tag;
    const id = row.ID ?? row.Id ?? row.id;
    if (repository && tag) return `${repository}:${tag}`;
    return id ?? "";
  } catch {
    return "";
  }
}

// Returns the git-sha label string, "" when the image has no such label, or
// null when the image could not be inspected at all.
function imageGitShaLabel(image) {
  try {
    const raw = execFileSync("docker", ["inspect", "--format", '{{ index .Config.Labels "git-sha" }}', image], {
      cwd: rootDir,
    })
      .toString("utf8")
      .trim();
    // Go templates print "<no value>" when the label map or key is absent;
    // normalize that to the "no label" case.
    return raw === "<no value>" ? "" : raw;
  } catch {
    return null;
  }
}

function short(sha) {
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`\nStatus failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
