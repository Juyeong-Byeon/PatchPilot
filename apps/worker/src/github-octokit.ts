import { Octokit } from "@octokit/rest";
import { throttling } from "@octokit/plugin-throttling";

const ThrottledOctokit = Octokit.plugin(throttling);

/**
 * How many times to auto-retry a request that GitHub rejected with a primary or
 * secondary rate-limit before giving up. Bounded so a genuinely exhausted quota
 * still surfaces as an error (and fails the job) instead of the worker hanging on
 * an unbounded backoff loop.
 */
const MAX_RATE_LIMIT_RETRIES = 2;

/**
 * Create a REST Octokit bound to `token` with primary + secondary rate-limit
 * handling (publish-path resilience).
 *
 * GitHub's REST API enforces both a primary hourly quota and short-lived
 * secondary ("abuse detection") limits. Publishing a PR makes a burst of
 * pulls.list/create/update calls, and merge reconciliation polls pulls.get; under
 * a busy token either can return 403/429. The throttling plugin serializes
 * requests through Bottleneck and, on a rate-limit response, waits the
 * server-provided `retryAfter` and retries up to {@link MAX_RATE_LIMIT_RETRIES}
 * times. The handlers return `true` to request a retry and `false` to stop, so a
 * persistently throttled token degrades to a normal error rather than an
 * indefinite wait.
 *
 * The return type is annotated as the base {@link Octokit} (not the plugin-
 * augmented constructor's instance type) so the emitted declaration stays
 * nameable — consumers only use the standard `rest.pulls.*` surface, and a
 * throttled instance is structurally an Octokit.
 */
export function createGitHubOctokit(token: string): Octokit {
  return new ThrottledOctokit({
    auth: token,
    throttle: {
      onRateLimit: (retryAfter, options, octokit, retryCount) => {
        octokit.log.warn(
          `GitHub rate limit hit for ${options.method} ${options.url} (retryAfter=${retryAfter}s, retry ${retryCount})`,
        );
        return retryCount < MAX_RATE_LIMIT_RETRIES;
      },
      onSecondaryRateLimit: (retryAfter, options, octokit, retryCount) => {
        octokit.log.warn(
          `GitHub secondary rate limit hit for ${options.method} ${options.url} (retryAfter=${retryAfter}s, retry ${retryCount})`,
        );
        return retryCount < MAX_RATE_LIMIT_RETRIES;
      },
    },
  });
}
