import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

export function assertAdminToken(request: FastifyRequest, expectedToken: string): void {
  if (request.headers.authorization !== `Bearer ${expectedToken}`) {
    const error = new Error("Unauthorized");
    Object.assign(error, { statusCode: 401 });
    throw error;
  }
}

/**
 * Legacy plain shared-secret check (`x-lark-webhook-secret`). Retained for
 * back-compat and used as the fallback path inside the hardened verifier when no
 * signature headers are present. Accepts any of the configured (rotation)
 * secrets via constant-time comparison.
 */
export function assertLarkWebhookSecret(request: FastifyRequest, expectedSecret: string | string[]): void {
  const headerValue = request.headers["x-lark-webhook-secret"];
  const providedSecret = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!providedSecret || !matchesAnySecret(providedSecret, toSecretList(expectedSecret))) {
    throw unauthorized("Invalid Lark webhook secret");
  }
}

export function assertGitHubWebhookSignature(request: FastifyRequest, expectedSecret: string, rawBody: string): void {
  const headerValue = request.headers["x-hub-signature-256"];
  const providedSignature = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const expectedSignature = `sha256=${createHmac("sha256", expectedSecret).update(rawBody).digest("hex")}`;
  if (!providedSignature || !safeEqual(providedSignature, expectedSignature)) {
    throw unauthorized("Invalid GitHub webhook signature");
  }
}

/**
 * Header names for the hardened (HMAC) Lark path. The signature is
 * `sha256=<hex>` of `HMAC(secret, "<timestamp>.<nonce>.<rawBody>")` — binding the
 * body, a unix-seconds timestamp, and a per-request nonce together so a captured
 * request can be neither mutated nor replayed.
 */
const LARK_SIGNATURE_HEADER = "x-lark-signature";
const LARK_TIMESTAMP_HEADER = "x-lark-timestamp";
const LARK_NONCE_HEADER = "x-lark-nonce";

export interface LarkWebhookVerifierOptions {
  /**
   * One or more shared secrets. Pass a comma-separated string or an array to run
   * old + new secrets side by side during a rotation (see SECRET ROTATION below).
   */
  secret: string | string[];
  /**
   * Max age (seconds) a signed request's timestamp may be, in either direction,
   * to tolerate small clock skew. Default 300s (5 min). Outside the window the
   * request is rejected even with a valid signature — this is the replay guard's
   * coarse bound; the nonce cache is the fine one.
   */
  replayWindowSeconds?: number;
  /** Injectable clock (ms) for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Hardened Lark webhook verifier (L5).
 *
 * Lark historically authenticated with a single plain shared-secret header, with
 * no body binding, timestamp, or replay protection — strictly weaker than the
 * GitHub body-HMAC path. This verifier closes that gap while staying
 * back-compatible:
 *
 *  - HARDENED PATH (preferred): if the request carries `x-lark-signature`,
 *    `x-lark-timestamp`, and `x-lark-nonce`, it must present a valid HMAC-SHA256
 *    over `"<timestamp>.<nonce>.<rawBody>"` keyed by one of the configured
 *    secrets, with the timestamp inside the replay window and a nonce not seen
 *    before. All comparisons are constant-time.
 *  - LEGACY PATH (back-compat): otherwise it falls back to the plain
 *    `x-lark-webhook-secret` header so existing callers and the e2e smoke keep
 *    working unchanged. Operators can require the hardened path by setting
 *    `requireSignedLarkWebhook` once all senders are upgraded.
 *
 * SECRET ROTATION runbook:
 *  1. Generate a new secret. Set `LARK_WEBHOOK_SECRET="<new>,<old>"` (new first)
 *     so the verifier accepts both — no downtime.
 *  2. Update the Lark sender to use `<new>`.
 *  3. Once traffic on `<old>` has drained (observe logs), set
 *     `LARK_WEBHOOK_SECRET="<new>"` to retire it.
 * The same comma-separated list works for both the hardened and legacy paths.
 *
 * The nonce cache is per-process and bounded; it is sufficient for single-node
 * replay defense. The timestamp window is the cross-restart / multi-node bound.
 */
export interface LarkWebhookVerifier {
  /** Throws a 401/403 http-shaped error on failure; returns void on success. */
  verify(request: FastifyRequest, rawBody: string): void;
}

export function createLarkWebhookVerifier(options: LarkWebhookVerifierOptions): LarkWebhookVerifier {
  const secrets = toSecretList(options.secret);
  if (secrets.length === 0) throw new Error("Lark webhook verifier requires at least one secret");
  const replayWindowSeconds = options.replayWindowSeconds ?? 300;
  const now = options.now ?? Date.now;
  // Bounded nonce cache: maps nonce -> expiry epoch ms. Entries live for the
  // replay window; we prune lazily on each verify so the map cannot grow without
  // bound under sustained signed traffic.
  const seenNonces = new Map<string, number>();

  const pruneExpired = (nowMs: number): void => {
    for (const [nonce, expiresAt] of seenNonces) {
      if (expiresAt <= nowMs) seenNonces.delete(nonce);
    }
  };

  return {
    verify(request: FastifyRequest, rawBody: string): void {
      const signature = firstHeader(request, LARK_SIGNATURE_HEADER);
      const timestamp = firstHeader(request, LARK_TIMESTAMP_HEADER);
      const nonce = firstHeader(request, LARK_NONCE_HEADER);

      // No signature headers at all → legacy plain-secret path (back-compat).
      if (!signature && !timestamp && !nonce) {
        assertLarkWebhookSecret(request, secrets);
        return;
      }

      // A partial signature set is a malformed/forged hardened request — never
      // silently downgrade to the plain path once any signed header is present.
      if (!signature || !timestamp || !nonce) {
        throw unauthorized("Incomplete Lark webhook signature headers");
      }

      const timestampSeconds = Number(timestamp);
      if (!Number.isFinite(timestampSeconds)) {
        throw unauthorized("Invalid Lark webhook timestamp");
      }
      const nowMs = now();
      const skewSeconds = Math.abs(nowMs / 1000 - timestampSeconds);
      if (skewSeconds > replayWindowSeconds) {
        // Outside the replay window: stale (or future-dated) request.
        throw replayRejected("Lark webhook timestamp outside the allowed window");
      }

      // Constant-time match against each configured secret (rotation-safe). A
      // match means some secret's HMAC over "<ts>.<nonce>.<body>" equals the
      // provided signature.
      if (!signatureMatchesAnySecret(signature, secrets, timestamp, nonce, rawBody)) {
        throw unauthorized("Invalid Lark webhook signature");
      }

      // Signature is valid and fresh — now enforce single-use via the nonce.
      pruneExpired(nowMs);
      if (seenNonces.has(nonce)) {
        throw replayRejected("Lark webhook nonce was already used");
      }
      seenNonces.set(nonce, nowMs + replayWindowSeconds * 1000);
    },
  };
}

/**
 * True when the provided `sha256=<hex>` signature equals the HMAC of
 * `"<timestamp>.<nonce>.<rawBody>"` under any configured secret. Every secret is
 * tested with a constant-time compare (no early exit) so a successful rotation
 * match does not leak which secret matched via timing.
 */
function signatureMatchesAnySecret(
  signature: string,
  secrets: string[],
  timestamp: string,
  nonce: string,
  rawBody: string,
): boolean {
  const message = `${timestamp}.${nonce}.${rawBody}`;
  let matched = false;
  for (const secret of secrets) {
    const candidate = `sha256=${createHmac("sha256", secret).update(message).digest("hex")}`;
    if (safeEqual(signature, candidate)) matched = true;
  }
  return matched;
}

function toSecretList(secret: string | string[]): string[] {
  const raw = Array.isArray(secret) ? secret : secret.split(",");
  return raw.map((value) => value.trim()).filter((value) => value.length > 0);
}

function matchesAnySecret(provided: string, secrets: string[]): boolean {
  // Constant-time against each configured secret. We intentionally test all of
  // them (no early exit on first mismatch beyond timingSafeEqual's own behavior)
  // to support rotation without leaking which secret matched via timing.
  let matched = false;
  for (const secret of secrets) {
    if (safeEqual(provided, secret)) matched = true;
  }
  return matched;
}

function firstHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function unauthorized(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 401 });
}

function replayRejected(message: string): Error {
  // 403 (not 401): the credential may be valid, but the request is being
  // replayed or is stale, which is a distinct, non-retriable condition.
  return Object.assign(new Error(message), { statusCode: 403 });
}
