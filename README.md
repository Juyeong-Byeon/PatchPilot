# PatchPilot

<p align="center">
  <img src="docs/assets/patchpilot-brand.svg" alt="PatchPilot brand mark" width="520" />
</p>

Lark Base tickets in, audited GitHub pull requests out.

This repository is a Docker Compose MVP for routing approved Lark Base records
to an agent runner, collecting logs/artifacts, applying repository policy gates,
and publishing pull requests. It includes an admin console for Korean and
English operations teams to inspect job state, retry or cancel jobs, read logs,
and debug execution with a Datadog-style span flow.

## What It Does

- Accepts Lark webhook events after a shared-secret check.
- Normalizes approved ticket records into durable jobs.
- Runs a mock executor for local development or a gstack-compatible runner in
  an isolated Docker workspace.
- Stores job phases, run attempts, logs, artifacts, policy results, and pull
  request metadata in Postgres.
- Publishes GitHub pull requests only after policy checks pass.
- Writes job status, PR metadata, and failure summaries back to the source Lark
  Base record.
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
  -> GitHub pull request
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
  API->>Lark: Mark PatchPilot Status = Queued
  Admin->>API: Poll jobs, events, logs, artifacts
  API->>DB: Read operational state
  API-->>Admin: Job list and detail payloads

  Queue-->>Worker: Deliver job payload
  Worker->>DB: Mark phase Queued / Planning
  Worker->>Runner: Launch isolated workspace container
  Runner->>GitHub: Clone or fetch target repository
  Runner->>Agent: Run configured agent command
  Agent->>Runner: Local commit, PR title/body, artifacts
  Runner-->>Worker: Agent result contract
  Worker->>DB: Persist logs, artifacts, run events

  Worker->>Policy: Validate result and protected paths
  Policy-->>Worker: Pass or fail with reason
  alt Policy passes
    Worker->>GitHub: Push work branch
    Worker->>GitHub: Open pull request
    GitHub-->>Worker: PR URL and metadata
    Worker->>DB: Mark NeedsReview and store PR metadata
    Worker->>Lark: Mark PatchPilot Status = NeedsReview
  else Policy fails or runner errors
    Worker->>DB: Mark Failed, failure category, next action
    Worker->>Lark: Mark PatchPilot Status = failed outcome
  end

  GitHub->>API: PR closed webhook
  API->>API: Verify x-hub-signature-256
  API->>DB: If merged, mark job Completed
  API->>Lark: Mark PatchPilot Status = Completed

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

- Node.js 24 — the version pinned in [`.nvmrc`](.nvmrc) and used by CI (`nvm use` to match)
- npm
- Docker and Docker Compose
- A GitHub personal access token with repository access for target repos
- Lark app credentials and a webhook shared secret for real webhook ingestion

## Quickstart

One command runs preflight checks, brings up Postgres/Redis/API/worker,
migrates the database (handling the host-vs-container database URL for you), and
waits for the API to report ready:

```bash
npm run setup
```

On success it prints the admin console URL (`http://localhost:3000`) and the
`ADMIN_TOKEN` to paste. `npm run setup` is idempotent and safe to re-run.

> **For AI coding agents:** see [docs/agent-setup.md](docs/agent-setup.md) for a
> deterministic, copy-pasteable setup-and-verify runbook with expected output
> and failure recovery. Point your agent at that file.

### Stack management

| Command            | What it does                                                         |
| ------------------ | -------------------------------------------------------------------- |
| `npm run setup`    | One-command bootstrap: preflight → up → migrate → wait for ready     |
| `npm run doctor`   | Re-run preflight checks (Docker + `.env`) without touching the stack |
| `npm run status`   | Container status plus the `/api/ready` readiness probe               |
| `npm run logs`     | Tail `api` and `worker` logs                                         |
| `npm run down`     | Stop the stack                                                       |
| `npm run reset:db` | Wipe the Postgres volume and re-migrate (destructive)                |

### Manual setup

Equivalent steps if you prefer to run them yourself:

```bash
cp .env.example .env
npm install
docker compose build
docker compose up -d --wait postgres redis
DATABASE_URL=postgres://ticket_to_pr:ticket_to_pr@localhost:5432/ticket_to_pr npm --workspace @ticket-to-pr/db run migrate
npm run docker:build-runtime
docker compose up -d --wait api
npm run docker:recreate-worker
docker compose logs -f api worker
```

Open the admin console at `http://localhost:3000` and enter `ADMIN_TOKEN` from
your local `.env`.

The checked-in `.env.example` uses Docker service hostnames (`@postgres`) for
containers. When running migrations from the host shell, use the `localhost`
database URL shown above — `npm run setup` does this rewrite automatically.

## Environment

[`.env.example`](.env.example) is the canonical, commented list of every
variable — copy it to `.env` and edit. `npm run doctor` validates `.env` against
the selected executor/publisher modes (and rejects placeholder secrets in real
mode). The snapshot below is a convenience reference; if it ever disagrees with
`.env.example`, the file wins.

```env
ADMIN_TOKEN=change-me-admin-token
DATABASE_URL=postgres://ticket_to_pr:ticket_to_pr@postgres:5432/ticket_to_pr
REDIS_URL=redis://redis:6379
LARK_APP_ID=cli_xxx
LARK_APP_SECRET=secret_xxx
LARK_WEBHOOK_SECRET=webhook_secret_xxx
LARK_BASE_APP_TOKEN=base_app_token_xxx
LARK_BASE_TABLE_ID=table_xxx
LARK_STATUS_FIELD=PatchPilot Status
LARK_JOB_ID_FIELD=PatchPilot Job ID
LARK_PR_URL_FIELD=PR URL
LARK_PR_NUMBER_FIELD=PR Number
LARK_FAILURE_FIELD=PatchPilot Failure
LARK_UPDATED_AT_FIELD=PatchPilot Updated At
GITHUB_TOKEN=github_pat_xxx
GITHUB_WEBHOOK_SECRET=github_webhook_secret_xxx
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
for real PR creation. Older local `.env` files with
`PUBLISHER_MODE=gstack` are treated as `github` by the worker for compatibility,
but new configs should use `github` explicitly.

Production-like GitHub publishing requires:

```env
WORKER_EXECUTOR_MODE=gstack
WORKER_PUBLISHER_MODE=github
GITHUB_TOKEN=github_pat_xxx
GITHUB_WEBHOOK_SECRET=github_webhook_secret_xxx
REPOSITORY_ALLOWLIST=owner/example-repo
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

> In `.env`, set `CODEX_*` and `GSTACK_SKILL_SOURCE_DIR` to **absolute paths**.
> Unlike shell command examples, `.env` values are not shell-expanded, so
> `$HOME/...` will not resolve when the worker mounts them into the runner.

### gstack staged pipeline (plan → implement → review → verify → document)

`codex-agent-runner.js` runs the agent in a single pass. By default it runs no
project verification, so its `tests` evidence is honestly `skipped`. Set
`CODEX_SELF_REVIEW=1` to add one optional lightweight self-review/verify pass
(the agent re-reads its own diff, fixes obvious defects, runs the project's quick
checks, and records the result as real `tests` evidence via `output/qa.json`). It
is off by default and is **not** the full staged pipeline — just one extra pass;
a failing self-review check fails the run.

To run the agent through gstack's staged workflow instead — a separate Codex pass
per stage (plan and review use gstack skills) — point `GSTACK_ARGS` at the staged
runner (keep `GSTACK_COMMAND=node`):

```env
GSTACK_COMMAND=node
GSTACK_ARGS=/opt/runner/apps/runner/dist/gstack-staged-runner.js
```

Stages run sequentially and fail fast (the stage name is included in the failure):

1. **plan** — `gstack-autoplan` writes an implementation plan to `output/plan.md`.
2. **implement** — plain Codex coding driven by the plan; creates local commits
   (committed before review so review/verify see the full diff).
3. **review** — `gstack-review` analyzes the diff and fixes blocking issues.
4. **verify** — runs the project's tests/build and writes a structured
   `output/qa.json` (`{passed, command, summary}`). A failing verification **fails
   the run**, and the result is recorded in the policy-gated `tests` field.
5. **document** — synthesizes a reviewer-facing PR description from the final diff
   and the stage notes into `output/pr-description.md`, with six fixed sections:
   아키텍처 변경점 · 새로 추가된 컴포넌트 · 데이터 플로우 · 실패 시나리오 ·
   트레이드오프 · 테스트 전략. Best-effort — if it produces nothing the PR still
   ships with the stage notes below.

The authored description leads the PR body, followed by each stage's notes, which
are also **surfaced in the admin console** (a "Pipeline stage notes" panel on the
job detail) — and the live sub-stages render as an "에이전트 단계" sub-track under
the Implementing phase. The platform still derives the PR's trusted git evidence
after the run. The same `CODEX_*` / `GSTACK_SKILL_SOURCE_DIR` mounts apply; the
runner image bundles `ripgrep`, which gstack skills require.

Operational notes:

- **Cost:** five Codex passes (four engineering stages each reload a large gstack
  skill, plus a short description pass), so a staged run costs roughly 4–5× the
  single-pass runner. Prefer it for higher-stakes tickets.
- **Cancel:** a cancel request stops the running runner container mid-execution
  and records the phase it was cancelled in. The whole pipeline shares one
  timeout, split evenly across stages.
- **Rollback:** point `GSTACK_ARGS` back at `codex-agent-runner.js` for single-pass.
- Browser-based QA via `gstack-qa` needs a headless browser in the runner image
  (not bundled); the verify stage uses test/build checks, not browser QA.

### Structured agent failures

When the agent (single-pass or any staged stage) cannot complete a ticket, it
writes `output/failure.json` (`{stage, category, message, nextAction}`) instead
of crashing opaquely. The runner converts that into a schema-valid result with
`status: failed` and the structured failure, so Admin's `Failure`/`Next Action`
fields carry the agent's own explanation. `category` drives retry policy: `infra`
(also `internal`/`transient`/`timeout`) is treated as retryable; `agent` and
`policy` are actionable and need the ticket or rules changed before retry. An
optional `retryable` boolean in the file overrides the category default. If no
valid `failure.json` is present, the original error still propagates unchanged.

## Lark Webhook

Webhook requests must include:

```http
x-lark-webhook-secret: <LARK_WEBHOOK_SECRET>
```

Requests without the shared secret are rejected before ticket processing.

## GitHub Webhook

Configure a GitHub repository webhook for pull request events:

```http
POST <PUBLIC_BASE_URL>/webhooks/github
x-hub-signature-256: sha256=<HMAC>
```

Use `GITHUB_WEBHOOK_SECRET` as the webhook secret. When GitHub sends a merged
`pull_request.closed` event, PatchPilot marks the matching job `Completed` and
writes `PatchPilot Status=Completed` back to Lark.

## Lark Status Write-back

Set `LARK_BASE_APP_TOKEN` and `LARK_BASE_TABLE_ID` to let PatchPilot update the
source Lark Base record after each major state transition. The default field
mapping writes:

- `PatchPilot Status`: `Queued`, `Running`, `NeedsReview`, `Completed`,
  `FailedActionable`, `FailedInternal`, or `Cancelled`.
- `PatchPilot Job ID`: durable job id for Admin lookup.
- `PR URL` and `PR Number`: published pull request metadata.
- `PatchPilot Failure`: latest failure summary.
- `PatchPilot Updated At`: ISO timestamp of the write-back.

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

- Korean default copy with a fully translated English language toggle.
- Job queue scanning with status-first rows and auto-refresh (paused when the
  tab is hidden).
- Clickable status metrics that filter the list (All / Running / Failed /
  Completed).
- Job detail with failure summary, failure category, and next action first.
- Copy-to-clipboard for job id and PR URL.
- Datadog-style phase spans for `Queued -> Planning -> Implementing ->
PolicyChecking -> Publishing -> Completed`.
- Span-to-log correlation by source for faster debugging.
- Pipeline stage notes (plan / review / verify) rendered from the staged runner,
  plus a live sub-stage indicator on the Implementing step (e.g. "리뷰 3/4") and
  highlighted stage dividers in the log stream.
- Artifacts, raw logs, retry, and cancel actions. Retry is enabled only for
  internally-failed jobs, matching the backend retry preflight. Cancelling a
  running job stops the runner container and shows where it was cancelled.

Run it directly during frontend work:

```bash
npm run dev:admin
```

## Health and Readiness

- `GET /api/health` — liveness. Dependency-free; returns `{ "ok": true }` as long
  as the process is serving.
- `GET /api/ready` — readiness. Probes Postgres and Redis and returns `503` with
  the failing dependency when either is down. Used by `npm run setup`,
  `npm run status`, and the Compose `api` healthcheck to wait for a genuinely
  usable stack.

## Development Checks

```bash
npm run format:check
npm run typecheck
npm run lint
npm test
npm run build
git diff --check
```

These mirror the gates CI enforces (`.github/workflows/ci.yml`). The database
repository test is skipped unless `DATABASE_URL` points at a live Postgres
database.

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
  PR text drafts only.

## Operations

See [docs/operations.md](docs/operations.md) for:

- Lark field mapping
- Required environment variables
- GitHub token scopes
- Smoke-test steps
- Retry/cancel behavior
- Workspace retention
- Security and policy boundaries

## License

PatchPilot is source-available under the Business Source License 1.1. See
[LICENSE](LICENSE).

- Additional production use is allowed for internal and non-competitive usage.
- Competitive hosted services, managed services, developer tools, agent
  platforms, or ticket-to-pull-request automation products require a commercial
  license.
- Each version converts to the Apache License, Version 2.0 four years after it
  is first publicly distributed.
