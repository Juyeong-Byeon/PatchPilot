# PatchPilot

<p align="center">
  <img src="docs/assets/patchpilot-brand.svg" alt="PatchPilot brand mark" width="520" />
</p>

<p align="center">
  <strong>A ticket goes in. An AI agent implements the change. An audited pull request comes out.</strong>
</p>

PatchPilot is an autonomous **ticket-to-PR** system. An approved Lark Base record
(or a GitHub event) becomes a durable job; a worker hands it to a gstack-compatible
AI runner that clones the target repository, implements the change, and drafts a
PR; a policy gate validates the result; and only then does the platform push the
branch and open a pull request. A Korean-first admin console (the "PatchPilot
운영 관리자") gives operations teams a Datadog-style view of every job's phases,
logs, artifacts, and failures.

> The repo runs as a Docker Compose MVP. A fully mock executor and publisher
> (`EXECUTOR_MODE=mock`, `PUBLISHER_MODE=mock`) let you exercise the entire
> ticket → PR → merge loop locally with no AI CLI, no GitHub token, and no real
> pull requests.

## Highlights

- **Ticket in, PR out.** Approved Lark Base records turn into pull requests with
  no human in the implementation loop.
- **Platform owns trust.** The agent only writes local commits and PR text; the
  platform owns branch push and PR creation, enforces a repository allowlist and
  a protected-path denylist, and requires real 40-character Git SHAs.
- **Mock stack for local dev.** `EXECUTOR_MODE=mock` / `PUBLISHER_MODE=mock`
  drives the full loop with no external dependencies — the basis of the
  `npm run e2e:smoke` gate.
- **Pluggable AI runner.** Swap in any gstack-compatible CLI; a Codex-backed
  runner and a multi-stage gstack pipeline (plan → implement → review → verify →
  document) are supported out of the box.
- **Observability built in.** A Korean/English admin console renders job phase
  spans, span-to-log correlation, agent sub-stages, artifacts, retry, and cancel.
- **Two-way status.** Job status, PR metadata, and failure summaries are written
  back to the source Lark Base record at every major state transition.

## Architecture

PatchPilot is an npm-workspaces monorepo (Node 24) with four apps and four
shared packages. Data flows in one direction — from ticket to pull request —
with the database as the durable record of every phase.

```text
Lark Base ticket  ──┐
                    ├─▶  apps/api      verify secret · upsert job · enqueue
GitHub PR webhook ──┘        │
                             ▼
                        Postgres + Redis/BullMQ
                             │
                             ▼
                      apps/worker      consume job · policy gate · publish
                             │
                             ▼
                      apps/runner      isolated Docker workspace · AI agent
                             │
                             ▼
                        GitHub pull request
                             │
                             ▼
                      apps/admin       observe · retry · cancel · debug
```

<details>
<summary>Full end-to-end sequence (Mermaid)</summary>

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

</details>

## Project Layout

```text
ticket-to-pr/
├── apps/
│   ├── api/      Fastify API: Lark + GitHub webhooks, admin endpoints
│   ├── worker/   BullMQ worker: executor orchestration, policy gate, publisher
│   ├── runner/   Container entrypoint: clones/fetches a repo and runs the agent
│   └── admin/    React + Vite admin console ("PatchPilot 운영 관리자")
├── packages/
│   ├── core/             shared schemas, result validation, masking, state helpers
│   ├── db/               Postgres schema and repositories
│   ├── queue/            queue payload contracts
│   └── runner-contract/  runner workspace path contracts
├── docker/       Dockerfiles for api, worker, and the runner image
├── scripts/      setup, preflight, status, e2e-smoke, and other operator tooling
└── docs/         agent-setup, operations, and adoption/improvement plans
```

Workspaces are published under the `@ticket-to-pr/*` scope (e.g.
`@ticket-to-pr/api`, `@ticket-to-pr/core`).

## Requirements

- **Node.js 24** — the version pinned in [`.nvmrc`](.nvmrc) and used by CI; run
  `nvm use` in the repo root to match.
- **npm** (the repo uses npm workspaces; no other package manager is required).
- **Docker** and **Docker Compose** for the local stack.
- For real (non-mock) runs:
  - A **GitHub personal access token** with repository access for the target repos.
  - **Lark app credentials** and a **webhook shared secret** for real webhook ingestion.

## Quickstart

```bash
# 1. Use the pinned Node version.
nvm use            # reads .nvmrc -> Node 24

# 2. Install workspace dependencies.
npm install

# 3. Create your env file (defaults are mock-mode and run with no real secrets).
cp .env.example .env

# 4. Bring up the whole stack: preflight -> Postgres/Redis/API/worker/admin ->
#    migrate -> wait for /api/ready.
npm run setup

# 5. With the stack up, run the mock end-to-end smoke
#    (Lark ticket -> NeedsReview -> merge -> Completed).
npm run e2e:smoke
```

`npm run setup` is idempotent and safe to re-run. On success it prints the admin
console URL (`http://localhost:5173`) and the `ADMIN_TOKEN` to paste. Open the
console and enter that token to watch jobs flow through.

`npm run e2e:smoke` drives the full loop against an **already-running** mock stack
— it does not start or stop containers, so run `npm run setup` (or otherwise bring
the stack up) first. It loads `.env`; use `npm run e2e:smoke -- --print-config`
to confirm the effective API URL before running the smoke.

> **For AI coding agents:** see [docs/agent-setup.md](docs/agent-setup.md) for a
> deterministic, copy-pasteable setup-and-verify runbook with expected output and
> failure recovery. Point your agent at that file.

### Manual setup

Equivalent steps if you prefer to run them yourself:

```bash
cp .env.example .env
npm install
docker compose build
docker compose up -d --wait postgres redis
DATABASE_URL=postgres://ticket_to_pr:ticket_to_pr@localhost:5432/ticket_to_pr \
  npm run db:migrate
npm run docker:build-runtime
docker compose up -d --wait api
npm run docker:recreate-worker
docker compose up -d --build admin
docker compose logs -f api worker admin
```

The checked-in `.env.example` uses Docker service hostnames (`@postgres`) for
containers. When running migrations from the host shell, use the `localhost`
database URL shown above — `npm run setup` does this rewrite automatically.

### Stack management

| Command                      | What it does                                                           |
| ---------------------------- | ---------------------------------------------------------------------- |
| `npm run setup`              | One-command bootstrap: preflight → up → migrate → wait for ready       |
| `npm run doctor`             | Re-run preflight checks (Docker + `.env`) without touching the stack   |
| `npm run doctor:strict`      | Treat preflight warnings as failures for real-mode readiness checks    |
| `npm run status`             | Container status plus API/admin reachability probes                    |
| `npm run status -- --strict` | Exit non-zero when API/admin/worker/stale-image checks are unhealthy   |
| `npm run verify`             | Local quality gate: format → typecheck → lint → test → build → secrets |
| `npm run docker:frontend`    | Rebuild/restart only the Docker-managed admin frontend                 |
| `npm run logs`               | Tail `api`, `worker`, and `admin` logs                                 |
| `npm run down`               | Stop the stack                                                         |
| `npm run reset:db`           | Wipe the Postgres volume and re-migrate (destructive)                  |

### Development update/watch

For active local development, refresh source/dependencies/DB state, then run the
host API/worker watch loop with the frontend managed by Docker:

```bash
npm run dev:update
npm run dev:watch
```

`dev:update` fetches and fast-forwards first, so it refuses to run on a dirty
working tree. If you are mid-change and only need to refresh dependencies,
shared infra, migrations, and build outputs, run:

```bash
npm run dev:refresh
```

Point Cloudflare Tunnel or Tailnet sharing at `HOST_ADMIN_PORT` (default `5173`),
not at a host-run Vite process.

The Admin UI shows a connection badge in the top bar and on the access-key
screen. Use it when several local frontends are open: it displays the frontend
origin, the API target, whether requests are proxied or direct, and the API
runtime/build that answered `/api/version`.

Local development should leave `VITE_ADMIN_API_BASE_URL` blank. In that mode the
browser calls the current frontend origin (`/api`) and the Vite server proxies to
`ADMIN_API_PROXY_TARGET`:

- Full Docker setup: `ADMIN_API_PROXY_TARGET=http://api:3000`
- `npm run dev:watch`: `ADMIN_API_PROXY_TARGET=http://host.docker.internal:<HOST_API_PORT>`

Set `VITE_ADMIN_API_BASE_URL` only for a deployment where the browser must call a
separate API origin directly.

### Develop a single app

Run one workspace's dev server directly during focused work:

```bash
npm run dev:api       # Fastify API
npm run dev:worker    # BullMQ worker
npm run dev:admin     # React admin console
```

## Environment

[`.env.example`](.env.example) is the canonical, commented list of every
variable — copy it to `.env` and edit. `npm run doctor` validates `.env` against
the selected executor/publisher modes (and rejects placeholder secrets in real
mode). The defaults are mock-mode, so a fresh copy runs the full local loop with
no real credentials.

### Filling `.env`

The local mock stack works with the defaults from `.env.example`. Replace secrets
only when you expose the admin console, receive real Lark webhooks, run the real
AI executor, or publish real GitHub PRs.

Generate local-only shared secrets with a password manager or:

```bash
openssl rand -hex 32
```

#### Runtime and local URLs

| Variable                  | Value format / example                             | How to choose or get it                                                                 | Required when                  |
| ------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------ |
| `NODE_ENV`                | `development`                                      | Use `development` locally. Use `production` only for a deployed stack.                  | Always                         |
| `PUBLIC_BASE_URL`         | `http://localhost:3000` or a public HTTPS URL      | Local: API origin. Deployed/tunnel: the externally reachable API base URL.              | Webhooks and links             |
| `HOST_API_PORT`           | `3000`                                             | Pick a free host port for the API. Change it if another service already uses `3000`.    | Local Docker/dev scripts       |
| `HOST_ADMIN_PORT`         | `5173`                                             | Pick a free host port for the admin Vite server. Change it if another frontend is open. | Local Docker/dev scripts       |
| `ADMIN_API_PROXY_TARGET`  | blank, `http://api:3000`, or host API URL          | Leave blank in `.env`; Compose and `dev:watch` set the right proxy target.              | Admin local proxy mode         |
| `VITE_ADMIN_API_BASE_URL` | blank or `https://api.example.com`                 | Leave blank locally. Set only when the browser must call a separate API origin.         | Browser-direct deployments     |
| `ADMIN_ALLOWED_HOSTS`     | blank, `my-host.tailnet.ts.net,.trycloudflare.com` | Leave blank for localhost. Add Tailnet/tunnel hostnames or suffixes when sharing admin. | Non-localhost admin dev server |
| `ADMIN_TOKEN`             | random string, e.g. output of `openssl rand`       | Generate it yourself. Enter the same value in the admin UI login screen.                | Admin API and console          |

#### Data stores

| Variable       | Value format / example                                            | How to choose or get it                                                                                                | Required when |
| -------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------- |
| `DATABASE_URL` | `postgres://ticket_to_pr:ticket_to_pr@postgres:5432/ticket_to_pr` | Compose default uses service host `postgres`. For host-run commands, scripts rewrite this to `localhost` where needed. | API, worker   |
| `REDIS_URL`    | `redis://redis:6379`                                              | Compose default uses service host `redis`. For host-run dev, `dev:watch` rewrites this to `redis://localhost:6379`.    | Queue/worker  |

#### Lark webhook and write-back

| Variable                | Value format / example  | How to choose or get it                                                                                                  | Required when               |
| ----------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| `LARK_WEBHOOK_SECRET`   | random string           | Generate it yourself and configure the same secret on the Lark automation/webhook that calls `POST /webhooks/lark`.      | Real Lark webhook ingestion |
| `LARK_APP_ID`           | `cli_...`               | Copy from the Lark developer app credentials for the app that can update the Base record.                                | Lark status write-back      |
| `LARK_APP_SECRET`       | secret string           | Copy from the same Lark developer app credentials as `LARK_APP_ID`.                                                      | Lark status write-back      |
| `LARK_BASE_APP_TOKEN`   | Base app token          | Copy from the Lark Base URL or Base developer/settings panel for the source Base app.                                    | Lark status write-back      |
| `LARK_BASE_TABLE_ID`    | table id                | Copy from the source Lark Base table URL or table settings/developer panel.                                              | Lark status write-back      |
| `LARK_STATUS_FIELD`     | `PatchPilot Status`     | Name of the Lark field PatchPilot should update with `Queued`, `Running`, `NeedsReview`, failure states, or `Cancelled`. | Optional; default shown     |
| `LARK_JOB_ID_FIELD`     | `PatchPilot Job ID`     | Name of the Lark field that stores the durable PatchPilot job id.                                                        | Optional; default shown     |
| `LARK_PR_URL_FIELD`     | `PR URL`                | Name of the Lark field that stores the GitHub PR URL.                                                                    | Optional; default shown     |
| `LARK_PR_NUMBER_FIELD`  | `PR Number`             | Name of the Lark field that stores the GitHub PR number.                                                                 | Optional; default shown     |
| `LARK_FAILURE_FIELD`    | `PatchPilot Failure`    | Name of the Lark field that stores the latest failure summary or needs-input question summary.                           | Optional; default shown     |
| `LARK_UPDATED_AT_FIELD` | `PatchPilot Updated At` | Name of the Lark field that stores the latest write-back timestamp.                                                      | Optional; default shown     |

The inbound Lark ticket itself must include the required fields listed in
[docs/operations.md](docs/operations.md#required-lark-fields). To opt a single
ticket into the staged pipeline, add a checkbox field named `Staged Pipeline`
and set it to `true`. `Priority=High` is priority only.

#### GitHub publishing and merge webhooks

| Variable                  | Value format / example     | How to choose or get it                                                                                                         | Required when                                   |
| ------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `GITHUB_TOKEN`            | `github_pat_...`           | Create a fine-grained GitHub PAT for selected target repos with `Contents: Read and write` and `Pull requests: Read and write`. | `PUBLISHER_MODE=github` or real runner git auth |
| `GITHUB_WEBHOOK_SECRET`   | random string              | Generate it yourself and set the same value as the GitHub repository webhook secret.                                            | GitHub merge webhook handling                   |
| `REPOSITORY_ALLOWLIST`    | `owner/repo,owner/another` | List only repositories PatchPilot may touch. Use GitHub `owner/repo` names.                                                     | Real runs and policy gate                       |
| `PROTECTED_PATH_DENYLIST` | `.env,.env.*,infra/**`     | List comma-separated paths/globs that must block publish if changed. Keep secrets and production infra here.                    | Real runs and policy gate                       |

Add a GitHub repository webhook for `pull_request` events pointing at:

```text
<PUBLIC_BASE_URL>/webhooks/github
```

#### Worker runtime and lifecycle

| Variable                          | Value format / example                | How to choose or get it                                                                                            | Required when          |
| --------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| `JOB_WORKSPACE_ROOT`              | `/work/jobs`                          | Directory inside the worker container where job workspaces are created. Keep the Compose default locally.          | Worker                 |
| `JOB_TIMEOUT_SECONDS`             | `3600`                                | Max runner wall-clock time per job. Increase only for known long-running repos or staged runs.                     | Worker                 |
| `FAILED_WORKSPACE_RETENTION_DAYS` | `7`                                   | Days to retain failed job workspaces for inspection before cleanup. `0` means cleanup can remove immediately.      | Workspace cleanup      |
| `EXECUTOR_MODE`                   | `mock` or `gstack`                    | Use `mock` for local smoke. Use `gstack` when the worker should launch the real runner container.                  | Worker                 |
| `PUBLISHER_MODE`                  | `mock` or `github`                    | Use `mock` for simulated PR metadata. Use `github` for real branch push and PR creation.                           | Worker                 |
| `RUNNER_IMAGE`                    | `ticket-to-pr-runner:local` or digest | Docker image tag/digest the worker launches for runner containers. Build it with `npm run docker:refresh-runtime`. | `EXECUTOR_MODE=gstack` |

Use `WORKER_EXECUTOR_MODE` and `WORKER_PUBLISHER_MODE` to override the worker's
modes without changing the app-wide variables. `gstack` is an executor mode, not
a publisher mode. Use `PUBLISHER_MODE=github` for real PR creation. Older local
`.env` files with `PUBLISHER_MODE=gstack` are treated as `github` by the worker
for compatibility, but new configs should use `github` explicitly.

#### AI runner and Codex mounts

| Variable                  | Value format / example                                 | How to choose or get it                                                                                      | Required when              |
| ------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | -------------------------- |
| `GSTACK_COMMAND`          | `node`                                                 | Command run inside the runner image. Use `node` for the bundled JS runner entrypoints.                       | `EXECUTOR_MODE=gstack`     |
| `GSTACK_ARGS`             | blank or one runner entrypoint path                    | Leave blank for per-ticket single/staged selection. Set only to force one entrypoint for every job.          | Optional global override   |
| `GSTACK_SINGLE_ARGS`      | `/opt/runner/apps/runner/dist/codex-agent-runner.js`   | Runner entrypoint for normal single-pass tickets. Keep the default unless you ship a custom runner.          | Per-ticket routing         |
| `GSTACK_STAGED_ARGS`      | `/opt/runner/apps/runner/dist/gstack-staged-runner.js` | Runner entrypoint for tickets with `Staged Pipeline=true`. Keep the default unless you ship a custom runner. | Per-ticket routing         |
| `GSTACK_INSTALL_COMMAND`  | `npm install -g @openai/codex@0.141.0`                 | Docker build command that installs the AI CLI into the runner image. Pin the CLI version you validated.      | Building real runner image |
| `CODEX_AUTH_FILE`         | absolute path, e.g. `/Users/me/.codex/auth.json`       | Path on the host to your Codex auth file. Use an absolute path; `.env` does not expand `$HOME` or `~`.       | Codex-backed real runner   |
| `CODEX_CONFIG_FILE`       | absolute path, e.g. `/Users/me/.codex/config.toml`     | Path on the host to your Codex config file. Use an absolute path.                                            | Codex-backed real runner   |
| `CODEX_SKILLS_DIR`        | absolute path, e.g. `/Users/me/.codex/skills`          | Path on the host to the Codex skills directory to mount read-only into runner containers.                    | Codex-backed real runner   |
| `GSTACK_SKILL_SOURCE_DIR` | absolute path, e.g. `/Users/me/gstack`                 | Path on the host to the gstack checkout root so skill symlinks/helper scripts resolve inside the runner.     | Codex/gstack skill runner  |

In `.env`, use absolute paths for `CODEX_*` and `GSTACK_SKILL_SOURCE_DIR`; shell
shortcuts such as `$HOME/...` and `~/...` are not expanded by Docker Compose.

Production-like GitHub publishing requires at minimum:

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
Docker daemon.

## AI Runner

The runner clones (or fetches) the target repository into an isolated Docker
workspace and invokes a gstack-compatible agent command. The default runner
Dockerfile intentionally ships **no** specific agent CLI — build a runner image
with the toolchain you want:

```bash
docker build \
  -f docker/runner.Dockerfile \
  --build-arg GSTACK_INSTALL_COMMAND='<install gstack-compatible CLI here>' \
  -t ticket-to-pr-runner:local .
```

In mock mode no external agent CLI is required. After changing worker or runner
source, rebuild and recreate those containers before an E2E smoke (a stale image
can keep old behavior even when the checkout has newer code):

```bash
npm run docker:refresh-runtime
```

### Codex-backed runner

For the Codex-backed runner used by local real-mode smoke tests, package Codex
into the image and pass login/config as read-only runtime mounts:

```env
GSTACK_INSTALL_COMMAND=npm install -g @openai/codex@0.141.0
GSTACK_COMMAND=node
GSTACK_ARGS=
GSTACK_SINGLE_ARGS=/opt/runner/apps/runner/dist/codex-agent-runner.js
GSTACK_STAGED_ARGS=/opt/runner/apps/runner/dist/gstack-staged-runner.js
CODEX_AUTH_FILE=/Users/me/.codex/auth.json
CODEX_CONFIG_FILE=/Users/me/.codex/config.toml
CODEX_SKILLS_DIR=/Users/me/.codex/skills
GSTACK_SKILL_SOURCE_DIR=/Users/me/gstack
```

`CODEX_AUTH_FILE` and `CODEX_CONFIG_FILE` are mounted read-only and copied into a
temporary `CODEX_HOME` inside the container; they must not be baked into the
image. `GSTACK_SKILL_SOURCE_DIR` should point at the gstack checkout root.
`npm run setup` syncs PatchPilot's bundled runner skills
(`patchpilot-ticket-runner`, `gstack-autoplan`, `gstack-review`) into
`CODEX_SKILLS_DIR` for gstack mode, and `npm run doctor:strict` catches missing
stage skills before the next staged run.

> In `.env`, set `CODEX_*` and `GSTACK_SKILL_SOURCE_DIR` to **absolute paths**.
> Unlike shell command examples, `.env` values are not shell-expanded, so
> `$HOME/...` will not resolve when the worker mounts them into the runner.

`codex-agent-runner.js` runs the agent in a single pass. Set `CODEX_SELF_REVIEW=1`
to add one optional lightweight self-review/verify pass (the agent re-reads its
own diff, fixes obvious defects, runs the project's quick checks, and records the
result as real `tests` evidence). It is off by default; a failing self-review
check fails the run.

### gstack staged pipeline

The worker keeps ticket priority separate from runner selection. `Priority=High`
only records priority; it does not imply staged execution. To run one ticket
through gstack's staged workflow — a separate Codex pass per stage — leave
`GSTACK_ARGS` blank, keep both per-mode entrypoints configured, and set the Lark
checkbox field `Staged Pipeline` to `true` on that ticket:

```env
GSTACK_COMMAND=node
GSTACK_ARGS=
GSTACK_SINGLE_ARGS=/opt/runner/apps/runner/dist/codex-agent-runner.js
GSTACK_STAGED_ARGS=/opt/runner/apps/runner/dist/gstack-staged-runner.js
```

Stages run sequentially and fail fast (the failing stage name is reported):

1. **plan** — `gstack-autoplan` writes an implementation plan to `output/plan.md`.
2. **implement** — Codex coding driven by the plan; creates local commits (before
   review, so review/verify see the full diff).
3. **review** — `gstack-review` analyzes the diff and fixes blocking issues.
4. **verify** — runs the project's tests/build and writes a structured
   `output/qa.json`. A failing verification **fails the run** and is recorded in
   the policy-gated `tests` field.
5. **document** — synthesizes a reviewer-facing PR description from the final diff
   into `output/pr-description.md` (best-effort).

Stage notes are surfaced in the admin console, and live sub-stages render under
the Implementing phase. A staged run costs roughly 4–5× a single-pass run, so it
is best reserved for higher-stakes tickets. `GSTACK_ARGS` remains a back-compat
escape hatch: when set, it forces one runner entrypoint for every job and bypasses
per-ticket pipeline selection.

### Structured agent failures

When the agent cannot complete a ticket it writes
`output/failure.json` (`{stage, category, message, nextAction}`) instead of
crashing opaquely. The runner converts that into a schema-valid `status: failed`
result, so Admin's `Failure` / `Next Action` fields carry the agent's own
explanation. `category` drives retry policy: `infra` (also
`internal`/`transient`/`timeout`) is retryable; `agent` and `policy` are
actionable and need the ticket or rules changed before retry. An optional
`retryable` boolean overrides the category default.

## Webhooks

### Lark

Inbound Lark webhook requests must include the shared secret; requests without it
are rejected before any ticket processing:

```http
x-lark-webhook-secret: <LARK_WEBHOOK_SECRET>
```

### GitHub

Configure a GitHub repository webhook for pull-request events, using
`GITHUB_WEBHOOK_SECRET` as the secret:

```http
POST <PUBLIC_BASE_URL>/webhooks/github
x-hub-signature-256: sha256=<HMAC>
```

When GitHub sends a merged `pull_request.closed` event, PatchPilot marks the
matching job `Completed` and writes `PatchPilot Status=Completed` back to Lark.

### Lark status write-back

Set `LARK_BASE_APP_TOKEN` and `LARK_BASE_TABLE_ID` to let PatchPilot update the
source Lark Base record after each major state transition. The default field
mapping writes:

- `PatchPilot Status`: `Queued`, `Running`, `NeedsReview`, `Completed`,
  `FailedActionable`, `FailedInternal`, or `Cancelled`.
- `PatchPilot Job ID`: durable job id for Admin lookup.
- `PR URL` and `PR Number`: published pull request metadata.
- `PatchPilot Failure`: latest failure summary.
- `PatchPilot Updated At`: ISO timestamp of the write-back.

## Admin Console

The admin UI (`apps/admin`, branded with
[`patchpilot-logo.svg`](apps/admin/src/assets/patchpilot-logo.svg)) supports:

- Korean default copy with a fully translated English language toggle.
- Job queue scanning with status-first rows and auto-refresh (paused when the tab
  is hidden), plus clickable status metrics that filter the list (All / Running /
  Failed / Completed).
- Job detail leading with failure summary, failure category, and next action;
  copy-to-clipboard for job id and PR URL.
- Datadog-style phase spans for `Queued -> Planning -> Implementing ->
PolicyChecking -> Publishing -> Completed`, with span-to-log correlation.
- Pipeline stage notes (plan / review / verify) from the staged runner, a live
  sub-stage indicator on the Implementing step, and highlighted stage dividers in
  the log stream.
- Artifacts, raw logs, retry, and cancel actions. Retry is enabled only for
  internally-failed jobs; cancelling a running job stops the runner container and
  shows where it was cancelled.

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

These mirror the gates CI enforces (`.github/workflows/ci.yml`), which also runs
`npm run scan:secrets` and a mock end-to-end smoke
(`.github/workflows/e2e-smoke.yml`). The database repository test is skipped
unless `DATABASE_URL` points at a live Postgres database.

## Security Boundary

- `.env` is gitignored and must never be committed.
- Admin API calls require `Authorization: Bearer <ADMIN_TOKEN>`.
- Lark webhook calls require `x-lark-webhook-secret`; GitHub webhooks require a
  valid `x-hub-signature-256`.
- GitHub tokens are passed only to git/GitHub operations and are masked from
  retained runner logs.
- The worker enforces `REPOSITORY_ALLOWLIST` before execution and publishing, and
  a protected-path denylist blocks sensitive files from being changed by agent
  output.
- Completed agent results must include full 40-character Git SHAs and a real PR
  body artifact.
- The platform owns push and PR creation. The agent creates local commits and PR
  text drafts only.

## Operations

See [docs/operations.md](docs/operations.md) for Lark field mapping, required
environment variables, GitHub token scopes, smoke-test steps, retry/cancel
behavior, workspace retention, and the full security and policy boundaries.

## License

PatchPilot is source-available under the Business Source License 1.1. See
[LICENSE](LICENSE).

- Additional production use is allowed for internal and non-competitive usage.
- Competitive hosted services, managed services, developer tools, agent
  platforms, or ticket-to-pull-request automation products require a commercial
  license.
- Each version converts to the Apache License, Version 2.0 four years after it is
  first publicly distributed.
  </content>
  </invoke>
