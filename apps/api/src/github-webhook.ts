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

interface GitHubPullRequestPayload {
  action?: string;
  repository?: {
    full_name?: string;
  };
  pull_request?: {
    number?: number;
    merged?: boolean;
    html_url?: string;
    merged_at?: string | null;
  };
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
