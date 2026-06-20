import type { LarkStatusUpdater } from "@ticket-to-pr/core";
import type { MarkPullRequestMergedInput, MarkPullRequestMergedResult } from "@ticket-to-pr/db";

export interface GitHubWebhookRepositories {
  markPullRequestMerged(input: MarkPullRequestMergedInput): Promise<MarkPullRequestMergedResult>;
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
  | { action: "completed"; jobId: string }
  | { action: "not_found" };

export async function handleGitHubPullRequestWebhook(
  payload: GitHubPullRequestPayload,
  repos: GitHubWebhookRepositories,
  larkUpdater?: LarkStatusUpdater,
): Promise<GitHubWebhookResult> {
  if (payload.action !== "closed" || payload.pull_request?.merged !== true) return { action: "ignored" };

  const repository = payload.repository?.full_name;
  const prNumber = payload.pull_request.number;
  if (!repository || !prNumber) return { action: "ignored" };

  const result = await repos.markPullRequestMerged({
    repository,
    prNumber,
    prUrl: payload.pull_request.html_url,
    mergedAt: payload.pull_request.merged_at,
  });
  if (result.status === "not_found") return { action: "not_found" };

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
