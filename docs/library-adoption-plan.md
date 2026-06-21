# Library Adoption Plan

_Produced 2026-06-21 from a multi-agent review of the `ticket-to-pr` monorepo: 4
domain reviewers (frontend / backend / infra / cross-cutting) surfaced 21
candidate libraries; 20 unique candidates were each challenged by two adversarial
lenses — "already solved in-repo?" and "hidden costs (ESM / bundle / maintenance /
churn)?" — before a final synthesis into the tiers below._

The bias of this plan is **conservative**: the repo is already strict-typed
(`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`, no-unsafe
ESLint) and deliberately lean (Fastify, BullMQ, `pg`, React/Vite, vitest). A
library only earns **Adopt now** if it solves a real, file-grounded pain that the
repo does not already handle, at low risk.

## Decision summary

| Library                                                                             | Tier          | Effort | Verdict shape                                      |
| ----------------------------------------------------------------------------------- | ------------- | ------ | -------------------------------------------------- |
| `@octokit/plugin-throttling`                                                        | **Adopt now** | S      | both lenses confirmed                              |
| root `.dockerignore`                                                                | **Adopt now** | S      | hidden-cost lens confirmed                         |
| `@octokit/rest` typed responses (`RestEndpointMethodTypes`)                         | Pilot         | S      | low-risk, touches a testability seam               |
| `zod` — backend env / api-schemas (existing dep, wider use)                         | Pilot         | M      | already a dep; risk of sentinel/strict regressions |
| `@tanstack/react-query`                                                             | Pilot         | L      | confirmed real pain, but largest behavior change   |
| `hadolint` (CI Dockerfile lint)                                                     | Pilot         | S      | net-new, zero runtime cost                         |
| `gitleaks` (CI secret scan)                                                         | Pilot         | M      | overlaps the existing zero-install secret gate     |
| `@vitest/coverage-v8`                                                               | Pilot         | M      | useful, but 5 configs make aggregation tricky      |
| `kysely`                                                                            | Defer         | XL     | concurrency invariants stay raw SQL regardless     |
| shared `zod` contracts package                                                      | Defer         | L      | the DTO duplication is small today                 |
| `react-router-dom`, `msw`, `knip`, `dive`, cross-platform `pino`                    | Defer         | —      | premature for current scale                        |
| `@fastify/type-provider-zod`, `@radix-ui/react-select`, `execa`, worker-only `pino` | Reject        | —      | already solved / not worth the churn               |

## Pilot execution outcomes (2026-06-21)

The Tier-2 pilots were taken on the same day, each as its own reviewed PR.

**Shipped:**

- `@octokit/plugin-throttling` + root `.dockerignore` — the Adopt-now pair.
- `hadolint` (Dockerfile lint, matrix, `failure-threshold: error`) + `gitleaks`
  (advisory full-history scan run via the official CLI image — the v2 action
  crashed under the default read-only token; `.gitleaks.toml` allowlists test
  placeholders; verified 0 leaks over 102 commits).
- `@vitest/coverage-v8` + `test:coverage` (opt-in; baseline ~74% lines).
- `zod` for the **API** env (`apps/api/src/env.ts`): fail-fast aggregation of all
  missing vars + PORT coercion/validation, no new dependency.
- `@tanstack/react-query` — the **full App.tsx migration** (not the declined slice
  below). Job-list + detail polling moved to `useQuery` with adaptive
  `refetchInterval` and a centralized `retry: false` / `enabled: !sessionExpired`
  401 boundary. The load-bearing timing tests pass byte-for-byte unchanged; the
  test-only microtask scheduler lives in `vitest.setup.ts` so production keeps
  React Query's default scheduler. (PR #36)

**Evaluated → declined** (the narrow first-scope was net-negative):

- `@octokit/rest` `RestEndpointMethodTypes` — the publish path is already
  octokit-typed; the only hand-written types are the intentional structural
  `PullsApiOctokit` test seam. Deriving it from the generated types would force
  `as` casts or large fixtures into the simple mocks
  (`{ data: { html_url, number } }`) — a test-ergonomics regression (and casts the
  repo's rules forbid) for zero runtime gain. **Keep the structural seam.**
- `@tanstack/react-query` **MetricsPanel slice** — MetricsPanel is a one-shot
  mount fetch (not a poller), so react-query's cache/dedup/refetch benefits barely
  apply; the slice would add the dependency + a global `QueryClientProvider` + a
  full rewrite of the panel's test harness (provider wrapper + async settling,
  flakiness risk) for negligible value. The real win is App.tsx's hand-rolled
  pollers (adaptive intervals + the 401-freeze boundary). **The slice was
  declined; the full App.tsx migration was instead shipped as a dedicated reviewed
  PR — see Shipped above.**

`zod` for the admin `api-schemas.ts` stays deferred (reverses the intentional
zero-extra-dep browser bundle).

## Tier 1 — Adopt now (shipped in this PR)

### `@octokit/plugin-throttling`

**Problem.** The worker creates `new Octokit({ auth })` in two places
(`apps/worker/src/publisher-github.ts`, `apps/worker/src/reconcile.ts`) with **no
rate-limit handling**. Publishing makes a burst of `pulls.list/create/update`
calls and merge reconciliation polls `pulls.get`; under a busy `GITHUB_TOKEN`
either can hit GitHub's primary hourly quota or a short secondary ("abuse") limit
and fail the **terminal publish step** outright.

**Change.** New `apps/worker/src/github-octokit.ts` exposes
`createGitHubOctokit(token)`, which applies the throttling plugin (Bottleneck-backed
queueing + bounded retry on 403/429, honoring the server `retryAfter`). Both call
sites use it. Retries are capped (`MAX_RATE_LIMIT_RETRIES = 2` ⇒ 3 total attempts)
so a persistently throttled token still surfaces as an error instead of hanging.
The factory returns the base `Octokit` type so the emitted `.d.ts` stays nameable
(avoids `TS2742` from the plugin-augmented constructor type); the runtime plugin is
unaffected by the widened compile-time type.

**Why now.** Both adversarial lenses confirmed: nothing in the repo already does
backoff, and the cost is one tiny dependency with no API-surface change.

### root `.dockerignore`

**Problem.** The api/worker/runner Dockerfiles `COPY` `packages/` + `apps/` then
run `npm ci` and rebuild from source — but with **no `.dockerignore`**, the build
context shipped `node_modules/`, stale `dist/`, the `work/` job volume, `.git`,
and local `.env` (~8.8 MB context, and a vector for stale artifacts / secrets in
the image).

**Change.** A conservative root `.dockerignore` excludes regenerated
(`node_modules`, `**/dist`), runtime (`work`), VCS/tooling (`.git`, `.github`,
`.claude`, `.superpowers`), and secret (`.env`, `.env.*`) paths. Verified against
every Dockerfile's `COPY` set — nothing the build needs is excluded.

## Tier 2 — Pilot (promising; ship behind a narrow first scope)

- **`@octokit/rest` typed responses via `RestEndpointMethodTypes`** — the publisher
  uses a hand-written structural `PullsApiOctokit` interface (good for test
  injection). Replacing it with octokit's generated types tightens the publish
  types but couples the testability seam; pilot it on `reconcile.ts` first.
- **`zod`, wider use (already a dependency)** — apply to backend env parsing
  (`apps/worker/src/env.ts`, api) and/or replace the admin's hand-written
  `api-schemas.ts` guards with `z.infer`. Down-ranked from adopt-now because the
  admin is intentionally a **zero-extra-dep browser bundle**, and the worker does
  not yet depend on zod; first PR = a single `core` env schema, measured.
- **`@tanstack/react-query`** — confirmed real pain (App.tsx hand-rolls adaptive
  pollers, a `visibilitychange` listener, manual refetch-after-mutation, and a
  freeze-on-401 flag threaded through five effect deps). But it is the largest
  behavior-bearing change in the app and tests assert exact polling/401 timing.
  First PR = migrate `MetricsPanel` only, reproducing intervals 1:1.
- **`hadolint`** — net-new, non-blocking CI step to lint the Dockerfiles. Zero
  runtime cost; first PR = advisory (non-failing) job.
- **`gitleaks`** — stronger secret scanning, but overlaps the existing
  `scripts/scan-secrets.mjs` zero-install gate; pilot as a parallel CI step and
  compare signal before replacing.
- **`@vitest/coverage-v8`** — add coverage reporting; the five per-workspace vitest
  configs make a single aggregated number tricky, so pilot per-workspace first.

## Tier 3 — Defer (revisit at larger scale)

- **`kysely`** — already evaluated and declined (see the earlier TypeORM
  discussion): the DB layer's correctness rests on Postgres-specific concurrency
  (advisory locks, guarded `update … returning`, `on conflict`, LATERAL, window
  functions) that stays raw SQL under any query builder. Revisit only if read-model
  typing churn grows. First useful step is non-library: extract a `withTransaction`
  helper.
- **shared `zod` contracts package** — the backend DTOs and admin guards are
  defined twice, but the surface is small; standardize naming first.
- **`react-router-dom`** (3 routes today), **`msw`** (test-mock duplication is
  modest), **`knip`** (ESLint + `tsc` already catch unused), **`dive`** (no image-size
  pain yet), **cross-platform `pino`** (worker logs already flow to `appendLog` /
  Postgres audit).

## Tier 4 — Reject

- **`@fastify/type-provider-zod`** — needs zod ≥4.2 and a repo-wide route migration;
  the existing parse helpers already validate inputs.
- **`@radix-ui/react-select`** — the admin already has a styled native-select
  wrapper; adds bundle + portal complexity for no needed feature.
- **`execa`** — `execFileSync`/`spawn` already cover the (few) script call sites
  with timeouts; a new dep in the runner image isn't justified.
- **worker-only `pino`** — operational logging already lands in the Postgres audit
  trail; a parallel logger would diverge from it.

## Deliberately preserved

These are **intentional** design decisions the review confirmed, not gaps:

- The admin SPA's **zero-extra-runtime-dep** validation layer (`api-schemas.ts`).
- The DB layer's **hand-written, concurrency-correct raw SQL** repositories.
- The publisher's **structural `PullsApiOctokit`** interface for test injection.
