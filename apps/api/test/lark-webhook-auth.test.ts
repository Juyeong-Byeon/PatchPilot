import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createLarkWebhookVerifier } from "../src/auth.js";

/** Minimal FastifyRequest stand-in carrying just the headers the verifier reads. */
function requestWith(headers: Record<string, string>): never {
  return { headers } as never;
}

function sign(secret: string, timestamp: string, nonce: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${nonce}.${body}`).digest("hex")}`;
}

const BODY = JSON.stringify({ recordId: "rec1", triggerVersion: "v1", fields: {} });

describe("createLarkWebhookVerifier — legacy plain-secret path (back-compat)", () => {
  it("accepts a matching x-lark-webhook-secret header", () => {
    const verifier = createLarkWebhookVerifier({ secret: "s3cret" });
    expect(() => verifier.verify(requestWith({ "x-lark-webhook-secret": "s3cret" }), BODY)).not.toThrow();
  });

  it("rejects a missing or wrong plain secret with 401", () => {
    const verifier = createLarkWebhookVerifier({ secret: "s3cret" });
    expect(() => verifier.verify(requestWith({}), BODY)).toThrowError(/Invalid Lark webhook secret/);
    expect(() => verifier.verify(requestWith({ "x-lark-webhook-secret": "wrong" }), BODY)).toThrowError(
      /Invalid Lark webhook secret/,
    );
  });
});

describe("createLarkWebhookVerifier — hardened signed path (L5)", () => {
  const now = () => 1_000_000_000_000; // fixed clock (ms)
  const timestamp = String(now() / 1000); // matching unix seconds
  const nonce = "nonce-abc";

  it("accepts a valid signature within the replay window", () => {
    const verifier = createLarkWebhookVerifier({ secret: "s3cret", now });
    const signature = sign("s3cret", timestamp, nonce, BODY);
    expect(() =>
      verifier.verify(
        requestWith({ "x-lark-signature": signature, "x-lark-timestamp": timestamp, "x-lark-nonce": nonce }),
        BODY,
      ),
    ).not.toThrow();
  });

  it("rejects a signature computed over a different body (tamper)", () => {
    const verifier = createLarkWebhookVerifier({ secret: "s3cret", now });
    const signature = sign("s3cret", timestamp, nonce, BODY);
    expect(() =>
      verifier.verify(
        requestWith({ "x-lark-signature": signature, "x-lark-timestamp": timestamp, "x-lark-nonce": nonce }),
        BODY + "tampered",
      ),
    ).toThrowError(/Invalid Lark webhook signature/);
  });

  it("rejects a stale timestamp outside the window with 403", () => {
    const verifier = createLarkWebhookVerifier({ secret: "s3cret", now, replayWindowSeconds: 60 });
    const staleTs = String(now() / 1000 - 3600); // an hour old
    const signature = sign("s3cret", staleTs, nonce, BODY);
    let thrown: unknown;
    try {
      verifier.verify(
        requestWith({ "x-lark-signature": signature, "x-lark-timestamp": staleTs, "x-lark-nonce": nonce }),
        BODY,
      );
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { statusCode?: number }).statusCode).toBe(403);
  });

  it("rejects a replayed nonce with 403 on the second use", () => {
    const verifier = createLarkWebhookVerifier({ secret: "s3cret", now });
    const signature = sign("s3cret", timestamp, nonce, BODY);
    const headers = { "x-lark-signature": signature, "x-lark-timestamp": timestamp, "x-lark-nonce": nonce };
    expect(() => verifier.verify(requestWith(headers), BODY)).not.toThrow();
    let thrown: unknown;
    try {
      verifier.verify(requestWith(headers), BODY);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { statusCode?: number }).statusCode).toBe(403);
    expect((thrown as Error).message).toMatch(/nonce/);
  });

  it("rejects a partial signature header set (no silent downgrade)", () => {
    const verifier = createLarkWebhookVerifier({ secret: "s3cret", now });
    expect(() => verifier.verify(requestWith({ "x-lark-signature": "sha256=deadbeef" }), BODY)).toThrowError(
      /Incomplete Lark webhook signature/,
    );
  });

  it("verifies under any rotation secret (new + old run side by side)", () => {
    const verifier = createLarkWebhookVerifier({ secret: "new-secret,old-secret", now });
    const underOld = sign("old-secret", timestamp, nonce, BODY);
    const underNew = sign("new-secret", timestamp, "nonce-2", BODY);
    expect(() =>
      verifier.verify(
        requestWith({ "x-lark-signature": underOld, "x-lark-timestamp": timestamp, "x-lark-nonce": nonce }),
        BODY,
      ),
    ).not.toThrow();
    expect(() =>
      verifier.verify(
        requestWith({ "x-lark-signature": underNew, "x-lark-timestamp": timestamp, "x-lark-nonce": "nonce-2" }),
        BODY,
      ),
    ).not.toThrow();
  });
});
