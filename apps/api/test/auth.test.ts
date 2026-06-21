import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import {
  assertAdminToken,
  assertGitHubWebhookSignature,
  assertLarkWebhookSecret,
  createLarkWebhookVerifier,
} from "../src/auth.js";

/**
 * The asserts under test read only `request.headers`. Method-position
 * parameters are checked bivariantly, so an interface whose methods narrow the
 * request to just its `headers` slice accepts the real (wider-parameter)
 * implementations with no cast. This is the escape-hatch-free way to feed a
 * `{ headers }` stub to functions whose declared parameter is the full
 * FastifyRequest — `headers` stays genuinely typed as IncomingHttpHeaders, so
 * the duplicate-header (`string[]`) and missing-header (`undefined`) cases are
 * type-checked, not cast away.
 */
type HeaderStub = Pick<FastifyRequest, "headers">;

interface AuthApi {
  assertAdminToken(request: HeaderStub, expectedToken: string): void;
  assertLarkWebhookSecret(request: HeaderStub, expectedSecret: string | string[]): void;
  assertGitHubWebhookSignature(request: HeaderStub, expectedSecret: string, rawBody: string): void;
}

const auth: AuthApi = { assertAdminToken, assertLarkWebhookSecret, assertGitHubWebhookSignature };

/** Verifier view that narrows `verify`'s request to the `headers` slice (same bivariance trick). */
interface StubLarkVerifier {
  verify(request: HeaderStub, rawBody: string): void;
}

/** Build a minimal request stub carrying only the headers the asserts read. */
function requestWith(headers: HeaderStub["headers"]): HeaderStub {
  return { headers };
}

/** Real HMAC GitHub signature — `sha256=<hex>` of HMAC(secret, rawBody). */
function githubSignature(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

/** Extract a numeric `statusCode` off a thrown http-shaped error, if present. */
function statusCodeOf(run: () => void): number | undefined {
  try {
    run();
  } catch (error) {
    return (error as { statusCode?: number }).statusCode;
  }
  return undefined;
}

describe("assertGitHubWebhookSignature", () => {
  const SECRET = "github-secret";
  const BODY = JSON.stringify({ action: "closed", pull_request: { number: 42 } });

  it("passes when the x-hub-signature-256 header matches the HMAC of the raw body", () => {
    const request = requestWith({ "x-hub-signature-256": githubSignature(SECRET, BODY) });
    expect(() => auth.assertGitHubWebhookSignature(request, SECRET, BODY)).not.toThrow();
  });

  it("throws (401) when the body was tampered after signing", () => {
    // Signature computed over the original body; the body presented is mutated,
    // so the recomputed HMAC no longer matches.
    const request = requestWith({ "x-hub-signature-256": githubSignature(SECRET, BODY) });
    expect(() => auth.assertGitHubWebhookSignature(request, SECRET, `${BODY}tampered`)).toThrowError(
      /Invalid GitHub webhook signature/,
    );
    expect(statusCodeOf(() => auth.assertGitHubWebhookSignature(request, SECRET, `${BODY}tampered`))).toBe(401);
  });

  it("throws (401) when the signature is computed under the wrong secret", () => {
    const request = requestWith({ "x-hub-signature-256": githubSignature("attacker-secret", BODY) });
    expect(statusCodeOf(() => auth.assertGitHubWebhookSignature(request, SECRET, BODY))).toBe(401);
  });

  it("throws (401) when the x-hub-signature-256 header is missing", () => {
    const request = requestWith({});
    expect(() => auth.assertGitHubWebhookSignature(request, SECRET, BODY)).toThrowError(
      /Invalid GitHub webhook signature/,
    );
    expect(statusCodeOf(() => auth.assertGitHubWebhookSignature(request, SECRET, BODY))).toBe(401);
  });

  it("uses the first value of an array-valued (duplicate) x-hub-signature-256 header", () => {
    // A duplicate header arrives as string[]; the code reads element [0]. A valid
    // first element passes even when a junk second element is present.
    const valid = githubSignature(SECRET, BODY);
    const passing = requestWith({ "x-hub-signature-256": [valid, "sha256=ignored"] });
    expect(() => auth.assertGitHubWebhookSignature(passing, SECRET, BODY)).not.toThrow();

    // ...and an invalid first element is rejected even if a later element is valid.
    const failing = requestWith({ "x-hub-signature-256": ["sha256=bad", valid] });
    expect(statusCodeOf(() => auth.assertGitHubWebhookSignature(failing, SECRET, BODY))).toBe(401);
  });

  it("throws (401) on an empty array-valued header (no first element)", () => {
    const request = requestWith({ "x-hub-signature-256": [] });
    expect(statusCodeOf(() => auth.assertGitHubWebhookSignature(request, SECRET, BODY))).toBe(401);
  });
});

describe("assertLarkWebhookSecret", () => {
  it("passes when x-lark-webhook-secret matches a single configured secret", () => {
    const request = requestWith({ "x-lark-webhook-secret": "s3cret" });
    expect(() => auth.assertLarkWebhookSecret(request, "s3cret")).not.toThrow();
  });

  it("passes when the secret matches any entry of a comma-separated rotation list", () => {
    const list = "new-secret,old-secret";
    expect(() =>
      auth.assertLarkWebhookSecret(requestWith({ "x-lark-webhook-secret": "new-secret" }), list),
    ).not.toThrow();
    expect(() =>
      auth.assertLarkWebhookSecret(requestWith({ "x-lark-webhook-secret": "old-secret" }), list),
    ).not.toThrow();
  });

  it("passes when the secret matches any entry of an array rotation list (whitespace trimmed)", () => {
    // toSecretList trims each entry, so a padded configured value still matches.
    const list = [" new-secret ", "old-secret"];
    expect(() =>
      auth.assertLarkWebhookSecret(requestWith({ "x-lark-webhook-secret": "new-secret" }), list),
    ).not.toThrow();
    expect(() =>
      auth.assertLarkWebhookSecret(requestWith({ "x-lark-webhook-secret": "old-secret" }), list),
    ).not.toThrow();
  });

  it("uses the first value of an array-valued (duplicate) x-lark-webhook-secret header", () => {
    const request = requestWith({ "x-lark-webhook-secret": ["s3cret", "ignored"] });
    expect(() => auth.assertLarkWebhookSecret(request, "s3cret")).not.toThrow();
  });

  it("throws (401) when the secret header is missing", () => {
    const request = requestWith({});
    expect(() => auth.assertLarkWebhookSecret(request, "s3cret")).toThrowError(/Invalid Lark webhook secret/);
    expect(statusCodeOf(() => auth.assertLarkWebhookSecret(request, "s3cret"))).toBe(401);
  });

  it("throws (401) when the secret is wrong (and against a rotation list)", () => {
    expect(
      statusCodeOf(() => auth.assertLarkWebhookSecret(requestWith({ "x-lark-webhook-secret": "nope" }), "s3cret")),
    ).toBe(401);
    expect(
      statusCodeOf(() =>
        auth.assertLarkWebhookSecret(requestWith({ "x-lark-webhook-secret": "nope" }), ["new-secret", "old-secret"]),
      ),
    ).toBe(401);
  });

  it("throws (401) on an empty array-valued header (no first element)", () => {
    const request = requestWith({ "x-lark-webhook-secret": [] });
    expect(statusCodeOf(() => auth.assertLarkWebhookSecret(request, "s3cret"))).toBe(401);
  });
});

describe("assertAdminToken", () => {
  const TOKEN = "admin-token";

  it("passes when authorization is exactly `Bearer <token>`", () => {
    const request = requestWith({ authorization: `Bearer ${TOKEN}` });
    expect(() => auth.assertAdminToken(request, TOKEN)).not.toThrow();
  });

  it("throws (401) when the authorization header is missing", () => {
    const request = requestWith({});
    expect(() => auth.assertAdminToken(request, TOKEN)).toThrowError(/Unauthorized/);
    expect(statusCodeOf(() => auth.assertAdminToken(request, TOKEN))).toBe(401);
  });

  it("throws (401) when the token is wrong", () => {
    const request = requestWith({ authorization: "Bearer wrong-token" });
    expect(statusCodeOf(() => auth.assertAdminToken(request, TOKEN))).toBe(401);
  });

  it("throws (401) when the `Bearer ` scheme prefix is missing (raw token only)", () => {
    const request = requestWith({ authorization: TOKEN });
    expect(statusCodeOf(() => auth.assertAdminToken(request, TOKEN))).toBe(401);
  });
});

describe("createLarkWebhookVerifier (smoke — covered in depth in lark-webhook-auth.test.ts)", () => {
  const BODY = JSON.stringify({ recordId: "rec1" });

  it("accepts a matching legacy plain secret and rejects a wrong one (401)", () => {
    const verifier: StubLarkVerifier = createLarkWebhookVerifier({ secret: "s3cret" });
    expect(() => verifier.verify(requestWith({ "x-lark-webhook-secret": "s3cret" }), BODY)).not.toThrow();
    expect(statusCodeOf(() => verifier.verify(requestWith({ "x-lark-webhook-secret": "wrong" }), BODY))).toBe(401);
  });
});
