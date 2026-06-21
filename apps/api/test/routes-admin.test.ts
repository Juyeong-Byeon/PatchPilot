import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server.js";

function makeRepos() {
  return {
    createJobFromTicket: vi.fn(),
    listJobs: vi.fn().mockResolvedValue([{ id: "job_1", phase: "Queued" }]),
    getJob: vi.fn().mockResolvedValue({ id: "job_1", phase: "Queued" }),
    getJobEvents: vi.fn().mockResolvedValue([{ event_type: "job.enqueued" }]),
    getJobLogs: vi.fn().mockResolvedValue([{ text: "queued" }]),
    getJobArtifacts: vi.fn().mockResolvedValue([{ kind: "result_json" }]),
    requestCancel: vi.fn().mockResolvedValue({ status: "requested" }),
    getRetryPreflight: vi.fn().mockResolvedValue({ jobId: "job_1", retryable: true, lastAttempt: 1 }),
    createRetryAttempt: vi.fn().mockResolvedValue({ runId: "run_2", attempt: 2 }),
    answerNeedsInput: vi.fn().mockResolvedValue({ runId: "run_2", attempt: 2 }),
    getMetrics: vi.fn().mockResolvedValue(emptyMetrics()),
    transitionJob: vi.fn().mockResolvedValue(undefined),
    appendEvent: vi.fn().mockResolvedValue(undefined),
  };
}

function emptyMetrics() {
  return {
    periodDays: null,
    totalJobs: 0,
    needsReviewJobs: 0,
    successRate: 0,
    failureBreakdown: { policy: 0, agent: 0, publish: 0, infra: 0, uncategorized: 0, total: 0 },
    runtimeSeconds: { p50: null, p95: null, sampleSize: 0 },
    mergeRate: 0,
    mergedJobs: 0,
    retryRate: 0,
    retriedJobs: 0,
    executorModeDistribution: { singlePass: 0, staged: 0, unknown: 0 },
  };
}

describe("admin routes", () => {
  it("requires bearer token for job routes", async () => {
    const app = await buildServer({
      adminToken: "secret",
      larkWebhookSecret: "webhook-secret",
      repos: makeRepos() as never,
      queue: { add: vi.fn() },
    });

    const response = await app.inject({ method: "GET", url: "/api/jobs" });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("lists jobs and job details for authorized admins", async () => {
    const repos = makeRepos();
    const app = await buildServer({
      adminToken: "secret",
      larkWebhookSecret: "webhook-secret",
      repos: repos as never,
      queue: { add: vi.fn() },
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/jobs",
      headers: { authorization: "Bearer secret" },
    });
    const detail = await app.inject({
      method: "GET",
      url: "/api/jobs/job_1/events",
      headers: { authorization: "Bearer secret" },
    });

    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([{ id: "job_1", phase: "Queued" }]);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toEqual([{ event_type: "job.enqueued" }]);
    await app.close();
  });

  it("cancels and retries jobs through admin actions", async () => {
    const repos = makeRepos();
    const queue = { add: vi.fn().mockResolvedValue({ id: "job_1" }) };
    const app = await buildServer({
      adminToken: "secret",
      larkWebhookSecret: "webhook-secret",
      repos: repos as never,
      queue,
    });

    const cancel = await app.inject({
      method: "POST",
      url: "/api/jobs/job_1/cancel",
      headers: { authorization: "Bearer secret" },
    });
    const retry = await app.inject({
      method: "POST",
      url: "/api/jobs/job_1/retry",
      headers: { authorization: "Bearer secret" },
    });

    expect(cancel.statusCode).toBe(200);
    expect(cancel.json()).toEqual({ ok: true, phase: "CancelRequested" });
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toEqual({ ok: true, runId: "run_2", attempt: 2 });
    expect(repos.requestCancel).toHaveBeenCalledWith("job_1", "admin");
    expect(repos.createRetryAttempt).toHaveBeenCalledWith("job_1", "admin", { guidance: null });
    expect(queue.add).toHaveBeenCalledWith(
      "job_1",
      {
        jobId: "job_1",
        runId: "run_2",
        attempt: 2,
      },
      { jobId: "job_1__run_2" },
    );
    await app.close();
  });

  it("rejects retry for non-terminal jobs", async () => {
    const repos = makeRepos();
    repos.getRetryPreflight.mockResolvedValue({ jobId: "job_1", retryable: false, phase: "Planning" });
    const app = await buildServer({
      adminToken: "secret",
      larkWebhookSecret: "webhook-secret",
      repos: repos as never,
      queue: { add: vi.fn() },
    });

    const retry = await app.inject({
      method: "POST",
      url: "/api/jobs/job_1/retry",
      headers: { authorization: "Bearer secret" },
    });

    expect(retry.statusCode).toBe(409);
    expect(repos.createRetryAttempt).not.toHaveBeenCalled();
    await app.close();
  });

  it("maps retry allocation races to conflict responses", async () => {
    const repos = makeRepos();
    repos.createRetryAttempt.mockRejectedValue(Object.assign(new Error("Job is not retryable"), { statusCode: 409 }));
    const app = await buildServer({
      adminToken: "secret",
      larkWebhookSecret: "webhook-secret",
      repos: repos as never,
      queue: { add: vi.fn() },
    });

    const retry = await app.inject({
      method: "POST",
      url: "/api/jobs/job_1/retry",
      headers: { authorization: "Bearer secret" },
    });

    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toEqual({ error: "Job is not retryable" });
    await app.close();
  });

  it("returns the retry job to failed when enqueue fails after allocation", async () => {
    const repos = makeRepos();
    const queue = { add: vi.fn().mockRejectedValue(new Error("redis unavailable")) };
    const app = await buildServer({
      adminToken: "secret",
      larkWebhookSecret: "webhook-secret",
      repos: repos as never,
      queue,
    });

    const retry = await app.inject({
      method: "POST",
      url: "/api/jobs/job_1/retry",
      headers: { authorization: "Bearer secret" },
    });

    expect(retry.statusCode).toBe(503);
    expect(retry.json()).toEqual({ error: "Retry enqueue failed" });
    expect(repos.transitionJob).toHaveBeenCalledWith("job_1", "Failed", "FailedInternal", "redis unavailable");
    expect(repos.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job_1",
        runId: "run_2",
        attempt: 2,
        phase: "Failed",
        eventType: "job.retry_enqueue_failed",
        source: "api",
      }),
    );
    await app.close();
  });

  it("reports missing and non-cancelable jobs on cancel", async () => {
    const repos = makeRepos();
    const app = await buildServer({
      adminToken: "secret",
      larkWebhookSecret: "webhook-secret",
      repos: repos as never,
      queue: { add: vi.fn() },
    });

    repos.requestCancel.mockResolvedValueOnce({ status: "not_found" });
    const missing = await app.inject({
      method: "POST",
      url: "/api/jobs/job_missing/cancel",
      headers: { authorization: "Bearer secret" },
    });

    repos.requestCancel.mockResolvedValueOnce({ status: "not_cancelable", phase: "Completed" });
    const terminal = await app.inject({
      method: "POST",
      url: "/api/jobs/job_done/cancel",
      headers: { authorization: "Bearer secret" },
    });

    expect(missing.statusCode).toBe(404);
    expect(terminal.statusCode).toBe(409);
    expect(terminal.json()).toEqual({ error: "Job is not cancelable", phase: "Completed" });
    await app.close();
  });

  it("rejects cancel while a job is publishing", async () => {
    const repos = makeRepos();
    repos.requestCancel.mockResolvedValue({ status: "not_cancelable", phase: "Publishing" });
    const app = await buildServer({
      adminToken: "secret",
      larkWebhookSecret: "webhook-secret",
      repos: repos as never,
      queue: { add: vi.fn() },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/jobs/job_publishing/cancel",
      headers: { authorization: "Bearer secret" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "Job is not cancelable", phase: "Publishing" });
    await app.close();
  });

  it("serves the built admin app when a static root is configured", async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), "ticket-to-pr-admin-"));
    await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>Ticket-to-PR</title>");
    const app = await buildServer({
      adminStaticRoot: staticRoot,
      adminToken: "secret",
      larkWebhookSecret: "webhook-secret",
      repos: makeRepos() as never,
      queue: { add: vi.fn() },
    });

    const response = await app.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Ticket-to-PR");
    await app.close();
  });
});

describe("metrics route (X5)", () => {
  it("requires the admin bearer token", async () => {
    const app = await buildServer({
      adminToken: "secret",
      larkWebhookSecret: "webhook-secret",
      repos: makeRepos() as never,
      queue: { add: vi.fn() },
    });

    const response = await app.inject({ method: "GET", url: "/api/metrics" });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("returns the aggregate for an authorized admin", async () => {
    const repos = makeRepos();
    const app = await buildServer({
      adminToken: "secret",
      larkWebhookSecret: "webhook-secret",
      repos: repos as never,
      queue: { add: vi.fn() },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/metrics",
      headers: { authorization: "Bearer secret" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(emptyMetrics());
    expect(repos.getMetrics).toHaveBeenCalledWith(undefined);
    await app.close();
  });

  it("passes a positive ?days window through to the repo", async () => {
    const repos = makeRepos();
    const app = await buildServer({
      adminToken: "secret",
      larkWebhookSecret: "webhook-secret",
      repos: repos as never,
      queue: { add: vi.fn() },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/metrics?days=7",
      headers: { authorization: "Bearer secret" },
    });

    expect(response.statusCode).toBe(200);
    expect(repos.getMetrics).toHaveBeenCalledWith(7);
    await app.close();
  });

  it("rejects a non-positive or non-integer ?days value", async () => {
    const repos = makeRepos();
    const app = await buildServer({
      adminToken: "secret",
      larkWebhookSecret: "webhook-secret",
      repos: repos as never,
      queue: { add: vi.fn() },
    });

    for (const days of ["0", "-3", "abc", "1.5"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/metrics?days=${days}`,
        headers: { authorization: "Bearer secret" },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(repos.getMetrics).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("answer a NeedsInput job (POST /api/jobs/:id/answer)", () => {
  it("answers a parked job: persists the answer as guidance and re-enqueues the new run", async () => {
    const repos = makeRepos();
    const queue = { add: vi.fn().mockResolvedValue({ id: "job_1" }) };
    const app = await buildServer({
      adminToken: "secret",
      larkWebhookSecret: "webhook-secret",
      repos: repos as never,
      queue,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/jobs/job_1/answer",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      payload: { answer: "Target the v2 API." },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ ok: true, runId: "run_2", attempt: 2 });
    expect(repos.answerNeedsInput).toHaveBeenCalledWith("job_1", "Target the v2 API.", "admin");
    // Re-enqueued exactly like a retry, with the per-attempt dedup jobId.
    expect(queue.add).toHaveBeenCalledWith(
      "job_1",
      { jobId: "job_1", runId: "run_2", attempt: 2 },
      { jobId: "job_1__run_2" },
    );
    await app.close();
  });

  it("returns 409 when the job is not awaiting input", async () => {
    const repos = makeRepos();
    repos.answerNeedsInput.mockRejectedValue(
      Object.assign(new Error("Job is not awaiting input"), { statusCode: 409 }),
    );
    const queue = { add: vi.fn() };
    const app = await buildServer({
      adminToken: "secret",
      larkWebhookSecret: "webhook-secret",
      repos: repos as never,
      queue,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/jobs/job_1/answer",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      payload: { answer: "too late" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "Job is not awaiting input" });
    // Nothing enqueued when the repo rejects.
    expect(queue.add).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects an empty, missing, or over-long answer with 400 (no repo call)", async () => {
    const repos = makeRepos();
    const app = await buildServer({
      adminToken: "secret",
      larkWebhookSecret: "webhook-secret",
      repos: repos as never,
      queue: { add: vi.fn() },
    });

    for (const payload of [{ answer: "   " }, { answer: 42 }, {}, { answer: "x".repeat(4001) }]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/jobs/job_1/answer",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(repos.answerNeedsInput).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns the job to Failed when the answer enqueue fails after allocation", async () => {
    const repos = makeRepos();
    const queue = { add: vi.fn().mockRejectedValue(new Error("redis unavailable")) };
    const app = await buildServer({
      adminToken: "secret",
      larkWebhookSecret: "webhook-secret",
      repos: repos as never,
      queue,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/jobs/job_1/answer",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      payload: { answer: "Use v2." },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Answer enqueue failed" });
    expect(repos.transitionJob).toHaveBeenCalledWith("job_1", "Failed", "FailedInternal", "redis unavailable");
    expect(repos.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "job.answer_enqueue_failed", source: "api" }),
    );
    await app.close();
  });

  it("requires the admin bearer token", async () => {
    const app = await buildServer({
      adminToken: "secret",
      larkWebhookSecret: "webhook-secret",
      repos: makeRepos() as never,
      queue: { add: vi.fn() },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/jobs/job_1/answer",
      headers: { "content-type": "application/json" },
      payload: { answer: "hi" },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

describe("retry with operator guidance (X4)", () => {
  it("unlocks a FailedActionable retry when guidance is supplied and persists it", async () => {
    const repos = makeRepos();
    repos.getRetryPreflight.mockResolvedValue({
      jobId: "job_1",
      retryable: false,
      phase: "Failed",
      outcome: "FailedActionable",
    });
    const queue = { add: vi.fn().mockResolvedValue({ id: "job_1" }) };
    const app = await buildServer({
      adminToken: "secret",
      larkWebhookSecret: "webhook-secret",
      repos: repos as never,
      queue,
    });

    const retry = await app.inject({
      method: "POST",
      url: "/api/jobs/job_1/retry",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      payload: { guidance: "Scope the change to auth.ts and add a test." },
    });

    expect(retry.statusCode).toBe(202);
    expect(repos.createRetryAttempt).toHaveBeenCalledWith("job_1", "admin", {
      guidance: "Scope the change to auth.ts and add a test.",
    });
    await app.close();
  });

  it("still rejects a FailedActionable retry without guidance", async () => {
    const repos = makeRepos();
    repos.getRetryPreflight.mockResolvedValue({
      jobId: "job_1",
      retryable: false,
      phase: "Failed",
      outcome: "FailedActionable",
    });
    const app = await buildServer({
      adminToken: "secret",
      larkWebhookSecret: "webhook-secret",
      repos: repos as never,
      queue: { add: vi.fn() },
    });

    const retry = await app.inject({
      method: "POST",
      url: "/api/jobs/job_1/retry",
      headers: { authorization: "Bearer secret" },
    });

    expect(retry.statusCode).toBe(409);
    expect(repos.createRetryAttempt).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a non-string or over-long guidance with 400", async () => {
    const repos = makeRepos();
    const app = await buildServer({
      adminToken: "secret",
      larkWebhookSecret: "webhook-secret",
      repos: repos as never,
      queue: { add: vi.fn() },
    });

    const tooLong = await app.inject({
      method: "POST",
      url: "/api/jobs/job_1/retry",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      payload: { guidance: "x".repeat(4001) },
    });
    const wrongType = await app.inject({
      method: "POST",
      url: "/api/jobs/job_1/retry",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      payload: { guidance: 42 },
    });

    expect(tooLong.statusCode).toBe(400);
    expect(wrongType.statusCode).toBe(400);
    expect(repos.createRetryAttempt).not.toHaveBeenCalled();
    await app.close();
  });

  it("treats whitespace-only guidance as none (FailedInternal still retries)", async () => {
    const repos = makeRepos();
    const queue = { add: vi.fn().mockResolvedValue({ id: "job_1" }) };
    const app = await buildServer({
      adminToken: "secret",
      larkWebhookSecret: "webhook-secret",
      repos: repos as never,
      queue,
    });

    const retry = await app.inject({
      method: "POST",
      url: "/api/jobs/job_1/retry",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      payload: { guidance: "   " },
    });

    expect(retry.statusCode).toBe(202);
    expect(repos.createRetryAttempt).toHaveBeenCalledWith("job_1", "admin", { guidance: null });
    await app.close();
  });
});
