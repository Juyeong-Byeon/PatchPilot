import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server.js";

const pullRequestMergedPayload = {
  action: "closed",
  repository: { full_name: "acme/web" },
  pull_request: {
    number: 42,
    merged: true,
    html_url: "https://github.com/acme/web/pull/42",
    merged_at: "2026-06-20T05:00:00Z"
  }
};

function signatureFor(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("github webhook route", () => {
  it("marks the job completed when a tracked pull request is merged", async () => {
    const repos = {
      createJobFromTicket: vi.fn(),
      appendEvent: vi.fn(),
      markPullRequestMerged: vi.fn().mockResolvedValue({
        status: "updated",
        jobId: "job_1",
        runId: "run_1",
        larkRecordId: "rec_1",
        prUrl: "https://github.com/acme/web/pull/42",
        prNumber: 42
      })
    };
    const larkUpdater = vi.fn().mockResolvedValue(undefined);
    const app = await buildServer({
      repos: repos as never,
      queue: { add: vi.fn() },
      larkWebhookSecret: "lark-secret",
      githubWebhookSecret: "github-secret",
      larkUpdater
    });
    const body = JSON.stringify(pullRequestMergedPayload);

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signatureFor("github-secret", body)
      },
      payload: body
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ action: "completed", jobId: "job_1" });
    expect(repos.markPullRequestMerged).toHaveBeenCalledWith({
      repository: "acme/web",
      prNumber: 42,
      prUrl: "https://github.com/acme/web/pull/42",
      mergedAt: "2026-06-20T05:00:00Z"
    });
    expect(larkUpdater).toHaveBeenCalledWith({
      recordId: "rec_1",
      status: "Completed",
      jobId: "job_1",
      prUrl: "https://github.com/acme/web/pull/42",
      prNumber: 42
    });
    await app.close();
  });

  it("rejects requests with an invalid signature", async () => {
    const app = await buildServer({
      repos: {
        createJobFromTicket: vi.fn(),
        appendEvent: vi.fn(),
        markPullRequestMerged: vi.fn()
      } as never,
      queue: { add: vi.fn() },
      larkWebhookSecret: "lark-secret",
      githubWebhookSecret: "github-secret"
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": "sha256=bad"
      },
      payload: JSON.stringify(pullRequestMergedPayload)
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("ignores closed pull requests that were not merged", async () => {
    const repos = {
      createJobFromTicket: vi.fn(),
      appendEvent: vi.fn(),
      markPullRequestMerged: vi.fn()
    };
    const app = await buildServer({
      repos: repos as never,
      queue: { add: vi.fn() },
      larkWebhookSecret: "lark-secret",
      githubWebhookSecret: "github-secret"
    });
    const payload = {
      ...pullRequestMergedPayload,
      pull_request: {
        ...pullRequestMergedPayload.pull_request,
        merged: false
      }
    };
    const body = JSON.stringify(payload);

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signatureFor("github-secret", body)
      },
      payload: body
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ action: "ignored" });
    expect(repos.markPullRequestMerged).not.toHaveBeenCalled();
    await app.close();
  });
});
