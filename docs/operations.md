# Ticket-to-PR Operations

This runbook covers the local Docker Compose MVP for receiving Lark Base tickets,
running agent work, and publishing reviewable GitHub pull requests.

## Required Lark Fields

The Lark webhook payload must include:

| Field | Type | Required value |
| --- | --- | --- |
| `Title` | text | Non-empty task title. |
| `Description` | text | Non-empty implementation context. |
| `Definition of Done` | text | Acceptance criteria for the agent. |
| `Repository` | text | Repository in the `owner/repo` format. |
| `Target Branch` | text | Base branch for the PR. |
| `Priority` | single select | `Low`, `Normal`, or `High`. |
| `Status` | single select/text | Must be `Progress` to enqueue work. |
| `Agent Run Requested` | checkbox | Must be `true` to enqueue work. |

`recordId` and `triggerVersion` are required envelope fields. Together they form
the idempotency key, so replays of the same trigger version do not create a
second active job.

## Required Environment

Copy `.env.example` to `.env` and replace secrets before starting the stack.

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | Runtime mode. Use `development` locally. |
| `PUBLIC_BASE_URL` | Public API/Admin base URL used in callbacks and links. |
| `ADMIN_TOKEN` | Bearer token required for `/api/jobs*` and the Admin UI. |
| `DATABASE_URL` | Postgres connection string. |
| `REDIS_URL` | Redis/BullMQ connection string. |
| `LARK_APP_ID` | Lark app id. |
| `LARK_APP_SECRET` | Lark app secret. |
| `LARK_WEBHOOK_SECRET` | Shared secret for validating webhook origin. |
| `GITHUB_TOKEN` | GitHub fine-grained PAT used by the platform publisher. |
| `REPOSITORY_ALLOWLIST` | Comma-separated `owner/repo` allowlist. |
| `PROTECTED_PATH_DENYLIST` | Comma-separated protected paths/globs that block publish. |
| `JOB_WORKSPACE_ROOT` | Host/container path where job workspaces are created. |
| `JOB_TIMEOUT_SECONDS` | Per-job execution timeout. |
| `FAILED_WORKSPACE_RETENTION_DAYS` | Days to retain failed workspaces for inspection. |
| `EXECUTOR_MODE` | `mock` for local smoke, `gstack` for real executor runs. |
| `PUBLISHER_MODE` | `mock` for simulated PR metadata, `github` for real PRs. |
| `RUNNER_IMAGE` | Fixed runner image name or digest used by workers. |

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

## Docker Startup

```bash
cp .env.example .env
docker compose build
docker compose up -d postgres redis
DATABASE_URL=postgres://ticket_to_pr:ticket_to_pr@localhost:5432/ticket_to_pr npm --workspace @ticket-to-pr/db run migrate
docker compose up -d api worker
docker compose logs -f api worker
```

Open `http://localhost:3000` for the operations console and enter the
`ADMIN_TOKEN` value from `.env`.

`.env.example` uses Docker service hostnames for processes running inside
Compose. Use the `localhost` database URL above for migrations launched from the
host shell.

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

## Real Executor Smoke

Use real mode only against a disposable test repository in the allowlist.

1. Build a runner image that includes the real `gstack` or compatible agent CLI.
   The stock Dockerfile provides a build hook:

   ```bash
   docker build \
     -f docker/runner.Dockerfile \
     --build-arg GSTACK_INSTALL_COMMAND='<install command for your runner CLI>' \
     -t ticket-to-pr-runner:local .
   ```

   Do not use `EXECUTOR_MODE=gstack` until `docker run --rm
   ticket-to-pr-runner:local sh -lc 'command -v gstack'` succeeds, or until
   `GSTACK_COMMAND` points at another compatible executable in the image.
2. Set `EXECUTOR_MODE=gstack` and `PUBLISHER_MODE=github`.
3. Set `GITHUB_TOKEN` to a fine-grained PAT scoped to the test repository.
4. Set `REPOSITORY_ALLOWLIST` to that test repository only.
5. Mount `/var/run/docker.sock:/var/run/docker.sock` into the worker only for
   this real executor test. The default mock compose file intentionally omits
   the socket so local smoke does not grant broad Docker host control.
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
11. Confirm Admin and Lark show the PR URL.

If worker or runner source changed since the last smoke, rebuild before
submitting the ticket:

```bash
docker compose build worker
docker build -f docker/runner.Dockerfile -t ticket-to-pr-runner:local .
docker compose up -d --force-recreate worker
```

This matters for GitHub auth fixes because the runner and worker execute from
Docker image layers, not directly from the live checkout.

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
- Review artifacts, especially `result_json`, policy reports, and PR drafts.

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
- The runner creates local commits and PR drafts, but the platform owns policy
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
