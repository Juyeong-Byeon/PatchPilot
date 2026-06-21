import { Octokit } from "@octokit/rest";
import type {
  JobAwaitingMergeReconcile,
  MarkPullRequestMergedInput,
  MarkPullRequestMergedResult,
} from "@ticket-to-pr/db";

/**
 * The slice of the repository the reconcile poller needs. Both methods already
 * exist on the real `Repositories` (T2 exports). Kept as a narrow interface so the
 * poller is unit-testable with a plain double.
 */
export interface ReconcileRepositories {
  listJobsAwaitingMergeReconcile(limit?: number): Promise<JobAwaitingMergeReconcile[]>;
  markPullRequestMerged(input: MarkPullRequestMergedInput): Promise<MarkPullRequestMergedResult>;
}

/**
 * Asks GitHub whether a single PR is merged. Returns `{ merged, mergedAt }` or
 * undefined when the merged state could not be determined (API error / not found)
 * — in which case the poller leaves the job untouched for the next tick.
 */
export type CheckPullRequestMerged = (
  repository: string,
  prNumber: number,
) => Promise<{ merged: boolean; mergedAt?: string | null } | undefined>;

export interface ReconcileOnceResult {
  scanned: number;
  merged: number;
  pending: number;
  errors: number;
}

/**
 * X1 reconcile: recover from missed merge webhooks (drift). For every job parked at
 * Completed/NeedsReview with an open PR, ask GitHub if the PR is merged and, when it
 * is, call `markPullRequestMerged` (idempotent — the in-DB terminal guard drops late
 * / duplicate applies). Safe when GitHub is unavailable: a check that throws or
 * returns undefined is counted as an error and skipped, never crashing the loop.
 */
export async function reconcileMergedPullRequestsOnce(
  repos: ReconcileRepositories,
  checkMerged: CheckPullRequestMerged,
  options: { limit?: number } = {},
): Promise<ReconcileOnceResult> {
  const jobs = await repos.listJobsAwaitingMergeReconcile(options.limit);
  const result: ReconcileOnceResult = { scanned: jobs.length, merged: 0, pending: 0, errors: 0 };

  for (const job of jobs) {
    let state: Awaited<ReturnType<CheckPullRequestMerged>>;
    try {
      state = await checkMerged(job.repository, job.prNumber);
    } catch {
      result.errors += 1;
      continue;
    }
    if (!state) {
      result.errors += 1;
      continue;
    }
    if (!state.merged) {
      result.pending += 1;
      continue;
    }
    try {
      const merged = await repos.markPullRequestMerged({
        repository: job.repository,
        prNumber: job.prNumber,
        prUrl: job.prUrl,
        mergedAt: state.mergedAt ?? null,
      });
      // Both 'updated' (first apply) and 'already_terminal' (a webhook beat us)
      // mean the job is now resolved; only count the first transition.
      if (merged.status === "updated") result.merged += 1;
    } catch {
      result.errors += 1;
    }
  }

  return result;
}

/**
 * Build a {@link CheckPullRequestMerged} backed by Octokit's `pulls.get`. A 404
 * (PR/repo gone) maps to "not merged" so the job stays put rather than erroring
 * forever; any other error propagates and is caught by the caller as an error tick.
 */
export function createGitHubMergeChecker(token: string): CheckPullRequestMerged {
  const octokit = new Octokit({ auth: token });
  return async (repository, prNumber) => {
    const [owner, repo] = repository.split("/");
    if (!owner || !repo) return undefined;
    try {
      const response = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
      return { merged: response.data.merged === true, mergedAt: response.data.merged_at };
    } catch (error) {
      if (typeof error === "object" && error !== null && "status" in error && error.status === 404) {
        return { merged: false };
      }
      return undefined;
    }
  };
}

export interface ReconcilePollerHandle {
  stop(): void;
}

/**
 * Start a periodic reconcile loop on `intervalMs`. Ticks are serialized (a slow
 * tick never overlaps the next) and never throw. Returns a handle whose `stop()`
 * clears the timer. The first tick fires after one interval, not immediately, so
 * worker startup stays fast.
 */
export function startReconcilePoller(
  repos: ReconcileRepositories,
  checkMerged: CheckPullRequestMerged,
  options: {
    intervalMs: number;
    limit?: number;
    onError?: (error: unknown) => void;
    onTick?: (result: ReconcileOnceResult) => void;
  },
): ReconcilePollerHandle {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const result = await reconcileMergedPullRequestsOnce(repos, checkMerged, { limit: options.limit });
      options.onTick?.(result);
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), options.intervalMs);
  // Do not keep the process alive solely for the poller.
  if (typeof timer.unref === "function") timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
