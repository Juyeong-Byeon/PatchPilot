#!/usr/bin/env node
// Mock-mode end-to-end smoke test for PatchPilot.
//
// Runs the full "Lark ticket in -> audited PR out -> merge -> Completed" loop
// against an ALREADY-RUNNING mock stack (EXECUTOR_MODE=mock, PUBLISHER_MODE=mock).
// It does NOT start or stop containers — the caller (CI workflow or a developer)
// is responsible for `docker compose up`/`down`. This keeps the script portable
// and fast to iterate on.
//
// Flow:
//   1. Wait for GET /api/ready (Postgres + Redis usable).
//   2. POST a valid /webhooks/lark event (x-lark-webhook-secret, Status=Progress,
//      Agent Run Requested=true, allowlisted repo) -> 202 enqueued + jobId.
//   3. Poll GET /api/jobs (Bearer ADMIN_TOKEN) until the job reaches
//      outcome=NeedsReview (mock publisher opened a PR) — fail clearly on timeout.
//   4. Assert a PR url is present on the job.
//   5. POST a mock GitHub pull_request.closed(merged) to /webhooks/github,
//      signed with GITHUB_WEBHOOK_SECRET -> 202 completed.
//   6. Poll until the job transitions to outcome=Completed.
//
// Any assertion failure exits non-zero with a readable message.
//
// Config (env, with .env.example-matching defaults):
//   HOST_API_PORT          (3000, or .env value)
//   ADMIN_TOKEN            (change-me-admin-token)
//   LARK_WEBHOOK_SECRET    (webhook_secret_xxx)
//   GITHUB_WEBHOOK_SECRET  (github_webhook_secret_xxx)
//   REPOSITORY_ALLOWLIST   (owner/repo)  — first entry is used as the target repo
//   E2E_BASE_URL           (http://localhost:<HOST_API_PORT>) — overrides the base
//   E2E_READY_TIMEOUT_MS   (60000)
//   E2E_POLL_TIMEOUT_MS    (120000)
//   E2E_POLL_INTERVAL_MS   (2000)
import { createHmac } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { parseEnvFile } from "./preflight.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

export function readConfig({ envFile = parseEnvFile(`${rootDir}.env`), processEnv = process.env } = {}) {
  const env = { ...envFile, ...processEnv };
  const port = env.HOST_API_PORT ?? "3000";
  const allowlist = (env.REPOSITORY_ALLOWLIST ?? "owner/repo")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const repository = allowlist[0] ?? "owner/repo";
  return {
    baseUrl: (env.E2E_BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
    adminToken: env.ADMIN_TOKEN ?? "change-me-admin-token",
    larkWebhookSecret: env.LARK_WEBHOOK_SECRET ?? "webhook_secret_xxx",
    githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET ?? "github_webhook_secret_xxx",
    repository,
    readyTimeoutMs: positiveInt(env.E2E_READY_TIMEOUT_MS, 60_000),
    pollTimeoutMs: positiveInt(env.E2E_POLL_TIMEOUT_MS, 120_000),
    pollIntervalMs: positiveInt(env.E2E_POLL_INTERVAL_MS, 2_000),
  };
}

export function usageText() {
  return [
    "PatchPilot mock e2e smoke.",
    "",
    "Usage:",
    "  npm run e2e:smoke                    # run against the configured stack",
    "  npm run e2e:smoke -- --print-config  # print effective non-secret config and exit",
    "  npm run e2e:smoke -- --help          # show this message",
    "",
    "Config is loaded from .env first, then process env overrides it.",
    "Use HOST_API_PORT or E2E_BASE_URL when the API is not on localhost:3000.",
  ].join("\n");
}

export function formatConfigForDisplay(config) {
  return [
    `baseUrl: ${config.baseUrl}`,
    `repository: ${config.repository}`,
    `readyTimeoutMs: ${config.readyTimeoutMs}`,
    `pollTimeoutMs: ${config.pollTimeoutMs}`,
    `pollIntervalMs: ${config.pollIntervalMs}`,
    `adminToken: ${config.adminToken ? "<set>" : "<empty>"}`,
    `larkWebhookSecret: ${config.larkWebhookSecret ? "<set>" : "<empty>"}`,
    `githubWebhookSecret: ${config.githubWebhookSecret ? "<set>" : "<empty>"}`,
  ].join("\n");
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

class SmokeError extends Error {}

function fail(message) {
  throw new SmokeError(message);
}

function log(message) {
  console.log(`[e2e-smoke] ${message}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Steps ----------------------------------------------------------------

async function waitForReady(config) {
  const url = `${config.baseUrl}/api/ready`;
  const deadline = Date.now() + config.readyTimeoutMs;
  log(`Waiting for ${url} (timeout ${config.readyTimeoutMs}ms)...`);
  let lastDetail = "no response yet";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        log("API is ready.");
        return;
      }
      const body = await safeText(res);
      const failure = classifyReadyFailure({
        body,
        contentType: res.headers.get("content-type") ?? "",
        status: res.status,
      });
      lastDetail = failure.message;
      if (!failure.retry) fail(failure.message);
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
    }
    await sleep(config.pollIntervalMs);
  }
  fail(`API never became ready within ${config.readyTimeoutMs}ms. Last: ${lastDetail}`);
}

export function classifyReadyFailure({ status, contentType = "", body = "" }) {
  const sample = body.trim().replace(/\s+/g, " ").slice(0, 240);
  const looksLikeHtml = contentType.includes("text/html") || /^<!doctype html|^<html/i.test(body.trim());
  if (looksLikeHtml) {
    return {
      retry: false,
      message:
        `HTTP ${status} from /api/ready looks like the wrong service, not the PatchPilot API. ` +
        "Check HOST_API_PORT or set E2E_BASE_URL to the API origin. " +
        `Body: ${sample || "(empty)"}`,
    };
  }
  return { retry: true, message: `HTTP ${status} ${sample}` };
}

async function postLarkWebhook(config) {
  const url = `${config.baseUrl}/webhooks/lark`;
  // A valid, job-creating ticket: Status=Progress + Agent Run Requested=true,
  // all required Lark fields present (see packages/core/src/lark.ts).
  const body = {
    recordId: `e2e-smoke-${Date.now()}`,
    triggerVersion: "e2e-smoke",
    fields: {
      Title: "E2E smoke: README note",
      Description: "Automated mock-mode smoke test ticket.",
      "Definition of Done": "PatchPilot opens a PR and reaches NeedsReview.",
      Repository: config.repository,
      "Target Branch": "main",
      Priority: "Normal",
      Status: "Progress",
      "Agent Run Requested": true,
    },
  };
  log(`POST ${url} (repository=${config.repository})`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lark-webhook-secret": config.larkWebhookSecret,
    },
    body: JSON.stringify(body),
  });
  const payload = await safeJson(res);
  if (res.status !== 202) {
    fail(`Expected 202 from /webhooks/lark, got HTTP ${res.status}: ${JSON.stringify(payload)}`);
  }
  if (payload?.action !== "enqueued" || typeof payload.jobId !== "string") {
    fail(`Expected { action: "enqueued", jobId } from /webhooks/lark, got: ${JSON.stringify(payload)}`);
  }
  log(`Job enqueued: ${payload.jobId}`);
  return payload.jobId;
}

async function fetchJob(config, jobId) {
  const res = await fetch(`${config.baseUrl}/api/jobs`, {
    headers: { authorization: `Bearer ${config.adminToken}` },
  });
  if (res.status === 401) {
    fail("GET /api/jobs returned 401 — ADMIN_TOKEN does not match the running stack.");
  }
  if (!res.ok) {
    fail(`GET /api/jobs failed: HTTP ${res.status} ${await safeText(res)}`);
  }
  const jobs = await safeJson(res);
  if (!Array.isArray(jobs)) {
    fail(`GET /api/jobs did not return an array: ${JSON.stringify(jobs)}`);
  }
  return jobs.find((job) => job?.id === jobId) ?? null;
}

async function pollForOutcome(config, jobId, expectedOutcome) {
  const deadline = Date.now() + config.pollTimeoutMs;
  log(`Polling /api/jobs for job ${jobId} -> outcome=${expectedOutcome} (timeout ${config.pollTimeoutMs}ms)...`);
  let lastOutcome = "(job not yet visible)";
  while (Date.now() < deadline) {
    const job = await fetchJob(config, jobId);
    if (job) {
      lastOutcome = `phase=${job.phase} outcome=${job.outcome}`;
      if (job.outcome === expectedOutcome) {
        log(`Reached outcome=${expectedOutcome} (${lastOutcome}).`);
        return job;
      }
      if (isTerminalFailure(job.outcome) && expectedOutcome !== job.outcome) {
        fail(
          `Job ${jobId} failed before reaching ${expectedOutcome}: ${lastOutcome} ` +
            `reason=${job.failure_reason ?? "(none)"}`,
        );
      }
    }
    await sleep(config.pollIntervalMs);
  }
  fail(`Job ${jobId} did not reach outcome=${expectedOutcome} within ${config.pollTimeoutMs}ms. Last: ${lastOutcome}`);
}

function isTerminalFailure(outcome) {
  return outcome === "FailedActionable" || outcome === "FailedInternal" || outcome === "Cancelled";
}

function assertPullRequest(job) {
  const prUrl = job.pr_url;
  if (typeof prUrl !== "string" || prUrl.length === 0) {
    fail(`Job reached NeedsReview but has no pr_url. Job: ${JSON.stringify(job)}`);
  }
  // The mock publisher always opens PR number 1; the URL is
  // https://github.local/<repo>/pull/mock-<jobId>. Prefer a real number parsed
  // from the URL when present, otherwise fall back to the mock constant.
  const numericMatch = /\/pull\/(\d+)/.exec(prUrl);
  const prNumber = numericMatch ? Number.parseInt(numericMatch[1], 10) : 1;
  log(`PR present: ${prUrl} (prNumber=${prNumber})`);
  return { prUrl, prNumber };
}

async function postGitHubMergeWebhook(config, { prUrl, prNumber }) {
  const url = `${config.baseUrl}/webhooks/github`;
  const payload = {
    action: "closed",
    repository: { full_name: config.repository },
    pull_request: {
      number: prNumber,
      merged: true,
      html_url: prUrl,
      merged_at: new Date().toISOString(),
    },
  };
  // The API verifies x-hub-signature-256 over the EXACT raw body bytes, so sign
  // the serialized string and send that same string as the request body.
  const rawBody = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", config.githubWebhookSecret).update(rawBody).digest("hex")}`;
  log(`POST ${url} (pull_request.closed merged, #${prNumber})`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-hub-signature-256": signature,
    },
    body: rawBody,
  });
  const responsePayload = await safeJson(res);
  if (res.status !== 202) {
    fail(`Expected 202 from /webhooks/github, got HTTP ${res.status}: ${JSON.stringify(responsePayload)}`);
  }
  if (responsePayload?.action !== "completed") {
    fail(`Expected { action: "completed" } from /webhooks/github, got: ${JSON.stringify(responsePayload)}`);
  }
  log("GitHub merge webhook accepted.");
}

// --- HTTP helpers ---------------------------------------------------------

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

// --- Main -----------------------------------------------------------------

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usageText());
    return;
  }
  const config = readConfig();
  if (process.argv.includes("--print-config")) {
    console.log(formatConfigForDisplay(config));
    return;
  }
  log(`Base URL: ${config.baseUrl}`);
  await waitForReady(config);

  const jobId = await postLarkWebhook(config);

  const needsReviewJob = await pollForOutcome(config, jobId, "NeedsReview");
  const pr = assertPullRequest(needsReviewJob);

  await postGitHubMergeWebhook(config, pr);
  await pollForOutcome(config, jobId, "Completed");

  log("✓ Mock e2e smoke passed: Lark -> NeedsReview -> merge -> Completed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    if (error instanceof SmokeError) {
      console.error(`\n[e2e-smoke] FAILED: ${error.message}`);
    } else {
      console.error(`\n[e2e-smoke] UNEXPECTED ERROR: ${error instanceof Error ? error.stack : String(error)}`);
    }
    process.exit(1);
  });
}
