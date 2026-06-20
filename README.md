# PatchPilot

<p align="center">
  <img src="docs/assets/patchpilot-brand.svg" alt="PatchPilot brand mark" width="520" />
</p>

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

## End-to-End Sequence

```mermaid
sequenceDiagram
  autonumber
  actor Operator as Lark Operator
  participant Lark as Lark Base
  participant API as Fastify API
  participant DB as Postgres
  participant Queue as Redis / BullMQ
  participant Worker as Worker
  participant Runner as Docker Runner
  participant Agent as gstack / Codex Agent
  participant Policy as Policy Gate
  participant GitHub as GitHub
  participant Admin as Admin Console

  Operator->>Lark: Approve ticket record
  Lark->>API: Webhook with shared secret
  API->>API: Verify x-lark-webhook-secret
  API->>DB: Upsert job, ticket snapshot, audit event
  API->>Queue: Enqueue run job
  Admin->>API: Poll jobs, events, logs, artifacts
  API->>DB: Read operational state
  API-->>Admin: Job list and detail payloads

  Queue-->>Worker: Deliver job payload
  Worker->>DB: Mark phase Queued / Planning
  Worker->>Runner: Launch isolated workspace container
  Runner->>GitHub: Clone or fetch target repository
  Runner->>Agent: Run configured agent command
  Agent->>Runner: Local commit, draft PR title/body, artifacts
  Runner-->>Worker: Agent result contract
  Worker->>DB: Persist logs, artifacts, run events

  Worker->>Policy: Validate result and protected paths
  Policy-->>Worker: Pass or fail with reason
  alt Policy passes
    Worker->>GitHub: Push work branch
    Worker->>GitHub: Open draft pull request
    GitHub-->>Worker: PR URL and metadata
    Worker->>DB: Mark Completed and store PR metadata
  else Policy fails or runner errors
    Worker->>DB: Mark Failed, failure category, next action
  end

  Admin->>API: Refresh detail every 3 seconds
  API->>DB: Read latest job trace
  API-->>Admin: Phase graph, timeline, logs, artifacts
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
CODEX_AUTH_FILE=
CODEX_CONFIG_FILE=
CODEX_SKILLS_DIR=
GSTACK_SKILL_SOURCE_DIR=
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

For a real Codex CLI runner smoke, package Codex into the runner image and pass
Codex login/config as read-only runtime mounts:

```env
GSTACK_INSTALL_COMMAND=npm install -g @openai/codex@0.141.0
GSTACK_COMMAND=node
GSTACK_ARGS=/opt/runner/apps/runner/dist/codex-agent-runner.js
CODEX_AUTH_FILE=/Users/me/.codex/auth.json
CODEX_CONFIG_FILE=/Users/me/.codex/config.toml
CODEX_SKILLS_DIR=/Users/me/.codex/skills
GSTACK_SKILL_SOURCE_DIR=/Users/me/gstack
```

`CODEX_AUTH_FILE` and `CODEX_CONFIG_FILE` are mounted into runner containers as
read-only seed files and copied into a temporary `CODEX_HOME` inside the
container. They must not be baked into the runner image. `GSTACK_SKILL_SOURCE_DIR`
should point at the gstack checkout root, not only `.agents/skills`, because the
Codex skills directory can contain symlinks to gstack helper binaries.

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

For the Codex-backed runner used by local real-mode smoke tests:

```bash
GSTACK_INSTALL_COMMAND='npm install -g @openai/codex@0.141.0' \
GSTACK_COMMAND=node \
GSTACK_ARGS=/opt/runner/apps/runner/dist/codex-agent-runner.js \
CODEX_AUTH_FILE="$HOME/.codex/auth.json" \
CODEX_CONFIG_FILE="$HOME/.codex/config.toml" \
CODEX_SKILLS_DIR="$HOME/.codex/skills" \
GSTACK_SKILL_SOURCE_DIR="$HOME/gstack" \
npm run docker:refresh-runtime
```

Package the image with a source/version tag such as
`ghcr.io/<owner>/ticket-to-pr-runner:codex-0.141.0-<git-sha>`. Keep credentials,
repository allowlists, and GitHub tokens outside the image and inject them only
at runtime.

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
