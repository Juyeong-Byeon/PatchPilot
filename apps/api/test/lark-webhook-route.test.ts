import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server.js";

const webhookBody = {
  recordId: "rec1",
  triggerVersion: "v1",
  fields: {
    Title: "Fix login",
    Description: "desc",
    "Definition of Done": "done",
    Repository: "acme/web",
    "Target Branch": "main",
    Priority: "Normal",
    Status: "Progress",
    "Agent Run Requested": true
  }
};

function makeDeps() {
  return {
    repos: {
      createJobFromTicket: vi.fn().mockResolvedValue({ jobId: "job_1", ticketSnapshotId: "ts_1", created: true }),
      appendEvent: vi.fn().mockResolvedValue(undefined)
    },
    queue: { add: vi.fn().mockResolvedValue({ id: "bull_1" }) }
  };
}

describe("lark webhook route", () => {
  it("requires an explicit secret or test bypass when building the server", async () => {
    const deps = makeDeps();

    await expect(buildServer(deps)).rejects.toThrow("Lark webhook secret is required");

    const app = await buildServer({ ...deps, allowUnauthenticatedLarkWebhook: true });
    await app.close();
  });

  it("rejects missing or invalid webhook secrets", async () => {
    const deps = makeDeps();
    const app = await buildServer({ ...deps, larkWebhookSecret: "secret" });

    const missing = await app.inject({ method: "POST", url: "/webhooks/lark", payload: webhookBody });
    const invalid = await app.inject({
      method: "POST",
      url: "/webhooks/lark",
      headers: { "x-lark-webhook-secret": "wrong" },
      payload: webhookBody
    });

    expect(missing.statusCode).toBe(401);
    expect(invalid.statusCode).toBe(401);
    expect(deps.queue.add).not.toHaveBeenCalled();
    await app.close();
  });

  it("accepts a valid webhook secret", async () => {
    const deps = makeDeps();
    const app = await buildServer({ ...deps, larkWebhookSecret: "secret" });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/lark",
      headers: { "x-lark-webhook-secret": "secret" },
      payload: webhookBody
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ action: "enqueued", jobId: "job_1" });
    await app.close();
  });
});
