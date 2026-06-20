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
    transitionJob: vi.fn().mockResolvedValue(undefined),
    appendEvent: vi.fn().mockResolvedValue(undefined),
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
    expect(repos.createRetryAttempt).toHaveBeenCalledWith("job_1", "admin");
    expect(queue.add).toHaveBeenCalledWith("job_1", {
      jobId: "job_1",
      runId: "run_2",
      attempt: 2,
    });
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
