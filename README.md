# AI Ticket-to-PR Agent Platform

Lark Base tickets in, audited GitHub pull requests out.

Canonical repository: `https://github.com/Juyeong-Byeon/ticket-to-pr`

This repository is a Docker Compose MVP for routing approved Lark Base records
to an agent runner, collecting logs/artifacts, applying repository policy gates,
and publishing draft pull requests. It includes an admin console for Korean and
English operations teams to inspect job state, retry or cancel jobs, read logs,
and debug execution with a Datadog-style span flow.

## What It Does

- Accepts Lark webhook events after a shared-secret check.
- Normalizes approved ticket records into durable jobs.
- Runs a mock executor for local development or a gstack-compatible runner in
  an isolated Docker workspace.
- Stores job phases, run attempts, logs, artifacts, policy results, and pull
  request metadata in Postgres.
- Publishes draft pull requests through GitHub only after policy checks pass.
- Provides an admin UI with Korean-first i18n, Tailwind v4, shadcn-style
  primitives, and Ease Health visual tokens.

## Architecture

```text
Lark Base
  -> API webhook
  -> Postgres job + audit records
  -> Redis/BullMQ queue
  -> Worker
  -> Docker runner workspace
  -> Policy gate
  -> GitHub draft pull request
  -> Admin console for observability
```

Workspaces:

- `apps/api`: Fastify API, Lark webhook, admin endpoints.
- `apps/worker`: BullMQ worker, executor orchestration, policy gate, publisher.
- `apps/runner`: container entrypoint that clones/fetches a repository and runs
  the agent command.
- `apps/admin`: React admin console.
- `packages/core`: shared schemas, result validation, masking, state helpers.
- `packages/db`: Postgres schema and repositories.
- `packages/queue`: queue payload contracts.
- `packages/runner-contract`: runner workspace path contracts.

## Requirements

- Node.js 20+
- npm
- Docker and Docker Compose
- A GitHub personal access token with repository access for target repos
- Lark app credentials and a webhook shared secret for real webhook ingestion

## Quickstart

```bash
cp .env.example .env
npm install
docker compose build
docker compose up -d postgres redis
DATABASE_URL=postgres://ticket_to_pr:ticket_to_pr@localhost:5432/ticket_to_pr npm --workspace @ticket-to-pr/db run migrate
npm run docker:build-runtime
docker compose up -d api
npm run docker:recreate-worker
docker compose logs -f api worker
```

Open the admin console at `http://localhost:3000` and enter `ADMIN_TOKEN` from
your local `.env`.

The checked-in `.env.example` uses Docker service hostnames for containers. Use
the `localhost` database URL above when running migrations from the host shell.

## Environment

Required for local compose:

```env
ADMIN_TOKEN=change-me-admin-token
DATABASE_URL=postgres://ticket_to_pr:ticket_to_pr@postgres:5432/ticket_to_pr
REDIS_URL=redis://redis:6379
LARK_APP_ID=cli_xxx
LARK_APP_SECRET=secret_xxx
LARK_WEBHOOK_SECRET=webhook_secret_xxx
GITHUB_TOKEN=github_pat_xxx
REPOSITORY_ALLOWLIST=owner/repo
PROTECTED_PATH_DENYLIST=.env,.env.*,infra/**,terraform/**,secrets/**,migrations/prod/**
EXECUTOR_MODE=mock
PUBLISHER_MODE=mock
RUNNER_IMAGE=ticket-to-pr-runner:local
WORKER_WORKSPACE_ROOT=/work/jobs
WORKER_WORKSPACE_HOST_ROOT=/absolute/path/to/ticket-to-pr/work/jobs
GSTACK_COMMAND=
GSTACK_ARGS=
```

Use `WORKER_EXECUTOR_MODE` and `WORKER_PUBLISHER_MODE` to override worker modes
without changing app-wide variables.

`gstack` is an executor mode, not a publisher mode. Use `PUBLISHER_MODE=github`
for real draft PR creation. Older local `.env` files with
`PUBLISHER_MODE=gstack` are treated as `github` by the worker for compatibility,
but new configs should use `github` explicitly.

Production-like GitHub publishing requires:

```env
WORKER_EXECUTOR_MODE=gstack
WORKER_PUBLISHER_MODE=github
GITHUB_TOKEN=github_pat_xxx
REPOSITORY_ALLOWLIST=Juyeong-Byeon/example-repo
```

The worker service mounts `/var/run/docker.sock` so `EXECUTOR_MODE=gstack` can
launch isolated runner containers. Keep real-mode runs limited to disposable,
allowlisted repositories because that mount grants the worker access to the host
Docker daemon. `WORKER_WORKSPACE_HOST_ROOT` is the same workspace directory as
`WORKER_WORKSPACE_ROOT`, but from the host Docker daemon's point of view; the
checked-in compose file defaults it to `${PWD}/work/jobs`.

For a deterministic platform smoke without a real AI CLI, rebuild the runner
image and run with:

```env
GSTACK_COMMAND=node
GSTACK_ARGS=/opt/runner/apps/runner/dist/e2e-smoke-runner.js
```

## Lark Webhook

Webhook requests must include:

```http
x-lark-webhook-secret: <LARK_WEBHOOK_SECRET>
```

Requests without the shared secret are rejected before ticket processing.

## Runner Image

The default runner Dockerfile intentionally does not install a specific agent
CLI. Build a runner image with the toolchain you want:

```bash
docker build \
  -f docker/runner.Dockerfile \
  --build-arg GSTACK_INSTALL_COMMAND='<install gstack-compatible CLI here>' \
  -t ticket-to-pr-runner:local .
```

In mock mode, no external agent CLI is required.

After changing worker or runner source, rebuild and recreate those containers
before running an E2E smoke. A stale image can keep old GitHub auth behavior even
when the checkout has newer code:

```bash
npm run docker:refresh-runtime
```

The runner image is registered in Compose as the `runner-image` build target
under the `build` profile, so the worker image and the runner image can be
rebuilt from the same checkout in one command.

## Admin Console

The admin UI supports:

- Korean default copy with English language toggle.
- Job queue scanning with status-first rows.
- Job detail with failure summary and next action first.
- Datadog-style phase spans for `Queued -> Planning -> Implementing ->
  PolicyChecking -> Publishing -> Completed`.
- Span-to-log correlation by source for faster debugging.
- Artifacts, raw logs, retry, and cancel actions.

Run it directly during frontend work:

```bash
npm run dev:admin
```

## Development Checks

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

The database repository test is skipped unless `DATABASE_URL` points at a live
Postgres database.

## Security Boundary

- `.env` is gitignored and must never be committed.
- Admin API calls require `Authorization: Bearer <ADMIN_TOKEN>`.
- Lark webhook calls require `x-lark-webhook-secret`.
- GitHub tokens are passed only to git/GitHub operations and are masked from
  retained runner logs.
- The worker enforces `REPOSITORY_ALLOWLIST` before execution and publishing.
- Protected path denylist blocks sensitive files from being changed by agent
  output.
- Completed agent results must include full 40-character Git SHAs and a real PR
  body artifact.
- The platform owns push and PR creation. The agent creates local commits and
  draft content only.

## Operations

See [docs/operations.md](docs/operations.md) for:

- Lark field mapping
- Required environment variables
- GitHub token scopes
- Smoke-test steps
- Retry/cancel behavior
- Workspace retention
- Security and policy boundaries

## Repository Status

This project is intended to live in a private GitHub repository because local
configuration and operational workflows reference private target repositories,
tokens, and Lark integration setup.
