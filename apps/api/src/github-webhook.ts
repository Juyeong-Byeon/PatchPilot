import { z } from "zod";
import type { LarkStatusUpdater } from "@ticket-to-pr/core";
import type {
  MarkPullRequestMergedInput,
  MarkPullRequestMergedResult,
  RecordWebhookDeliveryInput,
} from "@ticket-to-pr/db";

export interface GitHubWebhookRepositories {
  markPullRequestMerged(input: MarkPullRequestMergedInput): Promise<MarkPullRequestMergedResult>;
  /**
   * Optional: when present, a webhook delivery is recorded exactly once keyed by
   * its `x-github-delivery` id and replays are dropped before any state change.
   * Optional so callers that have not wired delivery-id dedup still typecheck;
   * the in-DB terminal-state guard in `markPullRequestMerged` remains a second,
   * always-on layer of idempotency even when this is absent.
   */
  recordWebhookDelivery?(input: RecordWebhookDeliveryInput): Promise<boolean>;
}

/**
 * Runtime shape check for the GitHub `pull_request` webhook body. Defense in
 * depth ON TOP of the HMAC signature in `assertGitHubWebhookSignature` — the
 * signature proves the bytes came from GitHub; this proves they have the shape
 * the handler reads. Every field is optional and `.passthrough()` keeps unknown
 * keys: GitHub sends a large payload and the handler only consumes a few fields,
 * so we validate the *types* of the ones we touch without rejecting the rest.
 * Anything that does not match (e.g. a non-merged close, a non-`pull_request`
 * event body) flows into the handler's existing `{ action: "ignored" }` path.
 */
export const githubPullRequestPayloadSchema = z
  .object({
    action: z.string().optional(),
    repository: z.object({ full_name: z.string().optional() }).passthrough().optional(),
    pull_request: z
      .object({
        number: z.number().optional(),
        merged: z.boolean().optional(),
        html_url: z.string().optional(),
        merged_at: z.string().nullish(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type GitHubPullRequestPayload = z.infer<typeof githubPullRequestPayloadSchema>;

/**
 * Parse an untrusted webhook body into the handler's payload shape. Returns
 * `null` when the body is not an object matching the schema; the route maps that
 * to the same safe `{ action: "ignored" }` / 200 response GitHub already gets for
 * any event it does not act on, so a malformed body never crashes the route.
 */
export function parseGitHubPullRequestPayload(body: unknown): GitHubPullRequestPayload | null {
  const result = githubPullRequestPayloadSchema.safeParse(body);
  return result.success ? result.data : null;
}

export type GitHubWebhookResult =
  | { action: "ignored" }
  | { action: "duplicate" }
  | { action: "already_completed"; jobId: string }
  | { action: "completed"; jobId: string }
  | { action: "not_found" };

export interface HandleGitHubWebhookOptions {
  /** GitHub `x-github-delivery` header — enables exactly-once dedup when present. */
  deliveryId?: string;
}

export async function handleGitHubPullRequestWebhook(
  payload: GitHubPullRequestPayload,
  repos: GitHubWebhookRepositories,
  larkUpdater?: LarkStatusUpdater,
  options: HandleGitHubWebhookOptions = {},
): Promise<GitHubWebhookResult> {
  if (payload.action !== "closed" || payload.pull_request?.merged !== true) return { action: "ignored" };

  const repository = payload.repository?.full_name;
  const prNumber = payload.pull_request.number;
  if (!repository || !prNumber) return { action: "ignored" };

  // First layer of idempotency: drop a delivery we have already recorded. Done
  // before any state change so a redelivered webhook produces no duplicate
  // transition, audit row, or Lark write. Requires the delivery id + the repo
  // method; when either is missing we fall through to the in-DB terminal guard.
  if (options.deliveryId && repos.recordWebhookDelivery) {
    const isFirstDelivery = await repos.recordWebhookDelivery({
      deliveryId: options.deliveryId,
      provider: "github",
      payload,
    });
    if (!isFirstDelivery) return { action: "duplicate" };
  }

  const result = await repos.markPullRequestMerged({
    repository,
    prNumber,
    prUrl: payload.pull_request.html_url,
    mergedAt: payload.pull_request.merged_at,
  });
  if (result.status === "not_found") return { action: "not_found" };

  // Second layer: the job was already terminal (late or duplicate merge that
  // slipped past delivery dedup, e.g. before this id was wired). The merge was
  // not re-applied; do not re-run the Lark write-back.
  if (result.status === "already_terminal") {
    return { action: "already_completed", jobId: result.jobId };
  }

  if (larkUpdater) {
    try {
      await larkUpdater({
        recordId: result.larkRecordId,
        status: "Completed",
        jobId: result.jobId,
        prUrl: result.prUrl,
        prNumber: result.prNumber,
      });
    } catch {
      // Lark write-back is best-effort; GitHub merge state is already persisted.
    }
  }

  return { action: "completed", jobId: result.jobId };
}
