import { createHmac } from "node:crypto";
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
    "Agent Run Requested": true,
  },
};

function makeDeps() {
  return {
    repos: {
      createJobFromTicket: vi.fn().mockResolvedValue({ jobId: "job_1", ticketSnapshotId: "ts_1", created: true }),
      appendEvent: vi.fn().mockResolvedValue(undefined),
    },
    queue: { add: vi.fn().mockResolvedValue({ id: "bull_1" }) },
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
      payload: webhookBody,
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
      payload: webhookBody,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ action: "enqueued", jobId: "job_1" });
    await app.close();
  });

  it("accepts a hardened signed request over the exact raw body (L5)", async () => {
    const deps = makeDeps();
    const app = await buildServer({ ...deps, larkWebhookSecret: "secret" });

    // Sign the EXACT JSON bytes Fastify will receive, like a real Lark sender.
    const rawBody = JSON.stringify(webhookBody);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = "route-nonce-1";
    const signature = `sha256=${createHmac("sha256", "secret")
      .update(`${timestamp}.${nonce}.${rawBody}`)
      .digest("hex")}`;

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/lark",
      headers: {
        "content-type": "application/json",
        "x-lark-signature": signature,
        "x-lark-timestamp": timestamp,
        "x-lark-nonce": nonce,
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ action: "enqueued", jobId: "job_1" });
    await app.close();
  });

  it("rejects an authentic but malformed body with 400 before any job work", async () => {
    const deps = makeDeps();
    const app = await buildServer({ ...deps, larkWebhookSecret: "secret" });

    // Correct secret (authentic) but the shape is wrong: `fields` is missing and
    // `recordId` is a number. The zod boundary check must 400 before
    // `parseLarkTicket`/`createJobFromTicket` runs — never a 500.
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/lark",
      headers: { "content-type": "application/json", "x-lark-webhook-secret": "secret" },
      payload: JSON.stringify({ recordId: 123, triggerVersion: "v1" }),
    });

    expect(response.statusCode).toBe(400);
    expect(deps.repos.createJobFromTicket).not.toHaveBeenCalled();
    expect(deps.queue.add).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a signed request whose signature does not match the body", async () => {
    const deps = makeDeps();
    const app = await buildServer({ ...deps, larkWebhookSecret: "secret" });

    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/lark",
      headers: {
        "content-type": "application/json",
        "x-lark-signature": "sha256=deadbeef",
        "x-lark-timestamp": timestamp,
        "x-lark-nonce": "route-nonce-2",
      },
      payload: JSON.stringify(webhookBody),
    });

    expect(response.statusCode).toBe(401);
    expect(deps.queue.add).not.toHaveBeenCalled();
    await app.close();
  });
});
