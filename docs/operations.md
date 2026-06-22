# PatchPilot Operations

This runbook covers the local Docker Compose MVP for receiving Lark Base tickets,
running agent work, and publishing reviewable GitHub pull requests.

## Required Lark Fields

The Lark webhook payload must include:

| Field                 | Type               | Required value                         |
| --------------------- | ------------------ | -------------------------------------- |
| `Title`               | text               | Non-empty task title.                  |
| `Description`         | text               | Non-empty implementation context.      |
| `Definition of Done`  | text               | Acceptance criteria for the agent.     |
| `Repository`          | text               | Repository in the `owner/repo` format. |
| `Target Branch`       | text               | Base branch for the PR.                |
| `Priority`            | single select      | `Low`, `Normal`, or `High`.            |
| `Status`              | single select/text | Must be `Progress` to enqueue work.    |
| `Agent Run Requested` | checkbox           | Must be `true` to enqueue work.        |

Optional ticket input fields:

| Field             | Type     | Meaning                                                                                                    |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `Staged Pipeline` | checkbox | When `true`, run this ticket through the staged pipeline. `Priority=High` does not imply staged execution. |

`recordId` and `triggerVersion` are required envelope fields. Together they form
the idempotency key, so replays of the same trigger version do not create a
second active job.

## Required Environment

Copy `.env.example` to `.env` and replace secrets before starting the stack.

| Variable                          | Purpose                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                        | Runtime mode. Use `development` locally.                                                                 |
| `PUBLIC_BASE_URL`                 | Public API/Admin base URL used in callbacks and links.                                                   |
| `ADMIN_TOKEN`                     | Bearer token required for `/api/jobs*` and the Admin UI.                                                 |
| `DATABASE_URL`                    | Postgres connection string.                                                                              |
| `REDIS_URL`                       | Redis/BullMQ connection string.                                                                          |
| `LARK_APP_ID`                     | Lark app id.                                                                                             |
| `LARK_APP_SECRET`                 | Lark app secret.                                                                                         |
| `LARK_WEBHOOK_SECRET`             | Shared secret for validating webhook origin.                                                             |
| `LARK_BASE_APP_TOKEN`             | Lark Base app token for source-record write-back.                                                        |
| `LARK_BASE_TABLE_ID`              | Lark Base table id for source-record write-back.                                                         |
| `LARK_STATUS_FIELD`               | Lark field that receives `Queued`, `Running`, `NeedsReview`, `Completed`, failed states, or `Cancelled`. |
| `LARK_JOB_ID_FIELD`               | Lark field that receives the PatchPilot job id.                                                          |
| `LARK_PR_URL_FIELD`               | Lark field that receives the published PR URL.                                                           |
| `LARK_PR_NUMBER_FIELD`            | Lark field that receives the published PR number.                                                        |
| `LARK_FAILURE_FIELD`              | Lark field that receives the latest failure summary.                                                     |
| `LARK_UPDATED_AT_FIELD`           | Lark field that receives the latest write-back timestamp.                                                |
| `GITHUB_TOKEN`                    | GitHub fine-grained PAT used by the platform publisher.                                                  |
| `GITHUB_WEBHOOK_SECRET`           | Shared secret for GitHub pull request merge webhooks.                                                    |
| `REPOSITORY_ALLOWLIST`            | Comma-separated `owner/repo` allowlist.                                                                  |
| `PROTECTED_PATH_DENYLIST`         | Comma-separated protected paths/globs that block publish.                                                |
| `JOB_WORKSPACE_ROOT`              | Host/container path where job workspaces are created.                                                    |
| `JOB_TIMEOUT_SECONDS`             | Per-job execution timeout.                                                                               |
| `FAILED_WORKSPACE_RETENTION_DAYS` | Days to retain failed workspaces for inspection.                                                         |
| `EXECUTOR_MODE`                   | `mock` for local smoke, `gstack` for real executor runs.                                                 |
| `PUBLISHER_MODE`                  | `mock` for simulated PR metadata, `github` for real PRs.                                                 |
| `RUNNER_IMAGE`                    | Fixed runner image name or digest used by workers.                                                       |

`gstack` belongs to `EXECUTOR_MODE`. The publisher only supports `mock` and
`github`; the worker accepts legacy app-wide `PUBLISHER_MODE=gstack` as a
compatibility alias for `github`, but operators should update `.env` to
`PUBLISHER_MODE=github` for real PR publishing. Explicit
`WORKER_PUBLISHER_MODE` values remain strict.

## GitHub PAT Scopes

Use a fine-grained personal access token, not a classic broad token.

- Resource owner: the GitHub owner that contains the target repository.
- Repository access: selected repositories only.
- Repository permissions: `Contents: Read and write`.
- Repository permissions: `Pull requests: Read and write`.
- Avoid granting organization, administration, secrets, workflow, or packages
  permissions for the MVP publisher.

## GitHub Webhook

Add a repository webhook that sends pull request events to:

```text
<PUBLIC_BASE_URL>/webhooks/github
```

Set the webhook secret to `GITHUB_WEBHOOK_SECRET`. PatchPilot verifies
`x-hub-signature-256`, ignores non-merged PR closures, and marks the matching
job `Completed` after GitHub reports that the PR was merged. The same transition
is written back to the source Lark Base record when Lark write-back is
configured.

## Docker Startup

```bash
cp .env.example .env
docker compose build
docker compose up -d postgres redis
DATABASE_URL=postgres://ticket_to_pr:ticket_to_pr@localhost:5432/ticket_to_pr npm --workspace @ticket-to-pr/db run migrate
npm run docker:build-runtime
docker compose up -d api
npm run docker:recreate-worker
docker compose up -d --build admin
docker compose logs -f api worker admin
```

Open `http://localhost:5173` for the Docker-managed operations console and enter
the `ADMIN_TOKEN` value from `.env`. The API remains available on
`http://localhost:3000` by default.

`.env.example` uses Docker service hostnames for processes running inside
Compose. Use the `localhost` database URL above for migrations launched from the
host shell.

## Development Source Update

During active development, use the host-run development update command instead
of rebuilding Docker app images after every source change:

```bash
npm run dev:update
```

`dev:update` does the following:

- fetches `origin` and fast-forwards the current branch;
- refuses to run when the working tree has uncommitted changes;
- runs `npm install`;
- starts only the shared infrastructure containers (`postgres` and `redis`);
- runs database migrations from the host using a `localhost` database URL;
- runs `npm run build` so workspace `dist/` outputs match the updated source.

It does not rebuild API/worker Docker images. It refuses to pull over
uncommitted changes. If your tree is dirty and you only need the non-git refresh
steps, run:

```bash
npm run dev:refresh
```

After either command finishes, run the app from the host checkout with:

```bash
npm run dev:watch
```

`dev:watch` keeps `postgres` and `redis` running in Docker, stops any stale
containerized `api`/`worker` services, builds once, then starts a Docker-managed
frontend (`admin`) plus TypeScript watch builds and host-run API/worker dev
servers. API/worker changes are compiled into `dist/`; `node --watch` restarts
those services when `dist/` changes. Admin changes are handled by the Vite
server inside the `admin` container, using the live checkout bind mount. In this
mode local changes are reflected without Docker image rebuilds for API/worker
code; the admin image is rebuilt only when the frontend container/dependency
environment changes.

Use `HOST_API_PORT` from `.env`; `dev:watch` passes that value as the API `PORT`
and points the Docker-managed frontend proxy at `host.docker.internal:<port>`
through `ADMIN_API_PROXY_TARGET`. Open the frontend at
`http://localhost:${HOST_ADMIN_PORT:-5173}`. If exposing it
through Cloudflare Tunnel or Tailnet, point the tunnel at `HOST_ADMIN_PORT` and
set `ADMIN_ALLOWED_HOSTS` to the stable host or a safe suffix such as
`.trycloudflare.com`.

The Admin UI displays its local wiring in the top bar: frontend origin, API
target, proxy/direct request mode, runtime modes, and build. If multiple Vite or
Docker frontends are open, check that badge first. Leave
`VITE_ADMIN_API_BASE_URL` blank for local proxy mode; set it only when the
browser should call a separate API origin directly.

To restart only the Docker-managed frontend, run:

```bash
npm run docker:frontend
```

Rebuild API/worker Docker images only when intentionally refreshing
containerized runtime code, for example with the operational
`npm run update -- --apply` flow or a targeted API image refresh:

```bash
docker compose up -d --build --force-recreate api
```

## Health Check

```bash
curl -fsS http://localhost:3000/api/health
```

Expected response:

```json
{ "ok": true }
```

## Mock Executor Smoke

Use mock mode for local verification without running the real gstack/Claude
executor or pushing to GitHub.

1. Set `EXECUTOR_MODE=mock` and `PUBLISHER_MODE=mock`.
2. Start Postgres, Redis, API, and worker.
3. Send a Lark webhook with header
   `x-lark-webhook-secret: <LARK_WEBHOOK_SECRET>`, all required fields,
   `Status=Progress`, and `Agent Run Requested=true`.
4. Confirm the job appears in Admin.
5. Confirm timeline events, logs, artifacts, and simulated PR metadata appear.
6. Confirm the successful user-facing outcome is `NeedsReview`.
7. Confirm Lark receives `PatchPilot Status=NeedsReview` when write-back is
   configured.

## Real Executor Smoke

Use real mode only against a disposable test repository in the allowlist.

1. Build a runner image that includes the real agent CLI. For the Codex-backed
   runner, install `@openai/codex` and use the adapter entrypoint:
   The stock Dockerfile provides a build hook:

   ```bash
   GSTACK_INSTALL_COMMAND='npm install -g @openai/codex@0.141.0' \
   GSTACK_COMMAND=node \
   GSTACK_ARGS= \
   GSTACK_SINGLE_ARGS=/opt/runner/apps/runner/dist/codex-agent-runner.js \
   GSTACK_STAGED_ARGS=/opt/runner/apps/runner/dist/gstack-staged-runner.js \
   CODEX_AUTH_FILE="$HOME/.codex/auth.json" \
   CODEX_CONFIG_FILE="$HOME/.codex/config.toml" \
   CODEX_SKILLS_DIR="$HOME/.codex/skills" \
   GSTACK_SKILL_SOURCE_DIR="$HOME/gstack" \
   npm run docker:refresh-runtime
   ```

   Do not bake Codex auth into the image. `CODEX_AUTH_FILE`,
   `CODEX_CONFIG_FILE`, and `CODEX_SKILLS_DIR` are mounted into each runner
   container as read-only seed inputs. `GSTACK_SKILL_SOURCE_DIR` should point at
   the gstack checkout root so Codex skill symlinks can resolve helper binaries.
   In `.env` (no shell expansion) use absolute paths, not `$HOME`. To run the
   staged gstack pipeline (plan → implement → review → verify → document) for a
   specific ticket, leave `GSTACK_ARGS` blank, keep `GSTACK_STAGED_ARGS` pointed
   at `gstack-staged-runner.js`, and set the ticket's `Staged Pipeline` checkbox
   to `true`. Staged runs cost ~4–5× the tokens (four engineering passes plus a
   short PR-description pass) and a failing verify stage fails the run. The final
   document stage authors the PR description and is best-effort (never blocks the
   PR). A cancel request stops the running runner container mid-execution and
   records the cancelled phase. `GSTACK_ARGS` is still supported as a global
   override when you intentionally want every job to use one runner entrypoint.
   Do not use `EXECUTOR_MODE=gstack` until `docker run --rm
ticket-to-pr-runner:local sh -lc 'command -v codex'` succeeds, or until
   `GSTACK_COMMAND` points at another compatible executable in the image.

2. Set `EXECUTOR_MODE=gstack` and `PUBLISHER_MODE=github`. Then run
   `npm run doctor` — in gstack mode it validates that the Codex/gstack mounts
   (`CODEX_AUTH_FILE`, `CODEX_CONFIG_FILE`, `CODEX_SKILLS_DIR`,
   `GSTACK_SKILL_SOURCE_DIR`) resolve to real paths, and warns when a value
   still uses `$HOME`/`~` (which `.env` does not expand). Fix any reported
   problem before launching a run so a bad mount fails here, not opaquely inside
   the runner container.
   To make the single-pass runner add one lightweight self-review/verify pass
   (review its own diff and run quick project checks, recorded as real `tests`
   evidence instead of `skipped`), set `CODEX_SELF_REVIEW=1`. It is off by
   default and is not the full staged pipeline; a failing self-review check
   fails the run.
3. Set `GITHUB_TOKEN` to a fine-grained PAT scoped to the test repository.
4. Set `REPOSITORY_ALLOWLIST` to that test repository only.
5. Confirm the worker service has `/var/run/docker.sock:/var/run/docker.sock`
   mounted. The runner container itself must not receive the Docker socket; only
   the worker needs it so it can launch the isolated runner container.
   Also confirm `WORKER_WORKSPACE_HOST_ROOT` points at the host path for the
   worker workspace, for example `/Users/me/ticket-to-pr/work/jobs`, because the
   host Docker daemon cannot mount the worker container's internal `/work` path.
6. Start the stack and submit a small Lark ticket.
7. Confirm the runner container can reach GitHub; real executor Docker runs use
   bridge networking for repository clone/fetch, while still avoiding Docker
   socket mounts inside the runner container.
8. Confirm the runner creates local commits in an isolated workspace.
9. Confirm the platform resolves the target branch SHA before runner execution,
   reads trusted git evidence from the mounted repo after the runner exits, and
   runs the policy gate against the exact audited commit SHA.
10. Confirm the platform pushes that audited SHA to the work branch and creates
    a PR.
11. Confirm Admin and Lark show the PR URL with `NeedsReview`.
12. Merge the test PR and confirm the GitHub webhook marks Admin and Lark as
    `Completed`.

If worker or runner source changed since the last smoke, rebuild before
submitting the ticket:

```bash
npm run docker:refresh-runtime
```

This matters for GitHub auth fixes because the runner and worker execute from
Docker image layers, not directly from the live checkout.

Do not fix dubious-ownership errors with `git config --global --add
safe.directory '*'`. The worker runs trusted Git reads and pushes with a
command-scoped `safe.directory=<repo>` setting so the exception stays limited to
the runner workspace being audited.

Do not run real mode against production repositories until the allowlist,
protected path denylist, and PAT scope have been reviewed.

## Failure Retention

Failed workspaces are retained for `FAILED_WORKSPACE_RETENTION_DAYS` so an
operator can inspect generated files, logs, and runner output. Successful
workspaces should be cleaned after artifacts and PR metadata have been stored.

Failure triage should start in Admin:

- Check the job `Failure` and `Next Action` fields.
- Inspect the run timeline for the first failing phase.
- Filter logs by `api`, `worker`, `runner`, `gstack`, `docker`, or `github`.
- Review artifacts, especially `result_json`, policy reports, and PR text
  drafts.

When the agent cannot complete a ticket (ambiguous request, missing dependency,
environment block) it writes `output/failure.json`
(`{stage, category, message, nextAction}`) instead of crashing. The runner turns
that into a schema-valid result with `status: failed` and structured failure
details, so the `Failure`/`Next Action` fields in Admin carry the agent's own
explanation. `category` drives retry policy: `infra` (or `internal`/`transient`/
`timeout`) failures are marked retryable; `agent` and `policy` failures are
actionable and need the ticket or rules changed before retrying.

## Retry and Cancel

`POST /api/jobs/:id/retry` creates a new run attempt and records `admin` as the
actor. Retry is intended for transient infrastructure, executor, or publisher
failures after the root cause has been understood.

`POST /api/jobs/:id/cancel` records `CancelRequested`. Queued jobs should stop
before execution. Running jobs cancel on a best-effort basis; operators should
verify the final timeline state and retained workspace.

Both routes require `Authorization: Bearer <ADMIN_TOKEN>`.

## Security Boundaries

- Admin routes are protected by `ADMIN_TOKEN`; keep it out of source control.
- The runner creates local commits and PR text drafts, but the platform owns policy
  gates, push, and PR creation.
- The GitHub token belongs to the platform publisher, not to the agent process.
- Repository access is constrained by `REPOSITORY_ALLOWLIST` before the runner
  container starts.
- Protected path changes are blocked by `PROTECTED_PATH_DENYLIST`.
- The publisher pushes the audited commit SHA, not a mutable local branch ref.
- Logs and artifacts must be treated as sensitive; token masking runs before
  persisting worker output and retained runner logs.
- Real executor smoke should use disposable repositories and least-privilege
  GitHub credentials.

## Secret Rotation

Rotate on a schedule and immediately on any suspected exposure (a secret printed
to logs, committed to git, or shared outside the operator group). All secrets
live in `.env`, which is never committed. After editing `.env`, the API and
worker must be restarted to pick up new values — they read the environment at
boot, not per request:

```bash
docker compose up -d --force-recreate api
npm run docker:recreate-worker
```

Validate the new values before restarting traffic:

```bash
npm run doctor
```

`doctor` rejects placeholder secrets and, in real mode, checks the runner
mounts. Use `npm run doctor:strict` before real-mode runs when warnings such as
literal `$HOME`/`~` mount paths should fail the check. It does not call
Lark/GitHub, so also confirm the live checks noted per secret below.

### Admin console — `ADMIN_TOKEN`

1. Generate a new high-entropy token, e.g. `openssl rand -hex 32`.
2. Set `ADMIN_TOKEN` in `.env` and recreate `api`.
3. Re-authenticate the Admin UI and update any scripts that send
   `Authorization: Bearer <ADMIN_TOKEN>` to `/api/jobs*`. Old sessions stop
   working immediately — there is no grace window.

### Lark — `LARK_APP_SECRET`, `LARK_WEBHOOK_SECRET`, `LARK_BASE_APP_TOKEN`

1. `LARK_APP_SECRET`: rotate in the Lark developer console (app credentials),
   then copy the new value into `.env`. This token mints tenant access tokens
   for status write-back, so a stale value breaks Lark updates, not ingestion.
2. `LARK_WEBHOOK_SECRET`: choose a new shared secret, set it in `.env`, and
   update the Lark automation/webhook caller to send the matching
   `x-lark-webhook-secret` header. Until both sides match, inbound webhooks are
   rejected with `401` — rotate the caller and `.env` together.
3. `LARK_BASE_APP_TOKEN`: regenerate in Lark Base, set in `.env`. Required only
   for source-record write-back.
4. Recreate `api` and `worker`. Confirm by sending one signed test webhook and
   watching a job reach `NeedsReview` with Lark status write-back, per the Mock
   Executor Smoke steps.

### GitHub — `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`

1. `GITHUB_TOKEN` (fine-grained PAT): mint a replacement with the same minimal
   scopes (see GitHub PAT Scopes — `Contents` and `Pull requests`,
   read/write, selected repositories only), set it in `.env`, recreate the
   `worker`, then revoke the old PAT in GitHub settings. Mint-then-revoke avoids
   a publish gap. The token belongs to the platform publisher, never the agent
   process or the runner container.
2. `GITHUB_WEBHOOK_SECRET`: set the new secret in `.env` and in the repository
   webhook settings (the same value verifies `x-hub-signature-256`). A mismatch
   makes merge webhooks fail signature checks and jobs stay `NeedsReview`;
   rotate `.env` and the GitHub webhook together, then recreate `api`.
3. After rotating, merge a PR on a disposable repository and confirm the webhook
   marks the job `Completed`, per the Real Executor Smoke steps.

### Post-rotation hygiene

- Scrub the exposed value from any logs or chat history.
- If a secret reached git history, rotating is necessary but not sufficient —
  treat the old value as permanently compromised and revoke it at the source.
- Never weaken masking to debug a rotation; token masking runs before worker
  output and retained runner logs are persisted and must stay on.
