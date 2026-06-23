# PatchPilot Setup Runbook (for AI Agents)

This is a deterministic, copy-pasteable runbook for an AI coding agent (or any
automated environment) to set up PatchPilot from a fresh checkout and verify it
works. Follow the steps in order. Each step lists the command, the expected
result, and what to do on failure.

PatchPilot defaults to **mock mode** (no real Lark/GitHub credentials needed), so
the default `.env` is enough to get a working local stack and admin console.

## 0. Prerequisites (verify, do not assume)

```bash
node --version      # expect v24 (pinned in .nvmrc; nvm use to match)
docker info         # must succeed (Docker daemon running)
docker compose version
```

If `docker info` fails, the Docker daemon is not running — start Docker Desktop
(or the `docker` service) before continuing. Everything else is handled by the
setup script. If Node is not v24 and `nvm` is unavailable on macOS, use the
Homebrew keg without changing the global `node` symlink:

```bash
brew install node@24
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run setup
```

## 1. One-command setup

```bash
npm run setup
```

This runs, in order: preflight checks → create `.env` from `.env.example` if
missing → auto-select fresh checkout ports if the defaults are already busy →
`npm install` → start and wait for Postgres + Redis → run migrations with the
**host** database URL → build the runner runtime image when
`EXECUTOR_MODE=gstack` → build and start the API + worker + Docker-managed admin
frontend → wait for the API readiness probe. It is idempotent; re-running is safe.

Expected tail of output:

```
✓ Setup complete.

  Admin console : http://localhost:5173
  API base      : http://localhost:3000
  Admin token   : change-me-admin-token
```

Use the printed `Admin token` to log into the console.

### If `npm run setup` fails

| Symptom                                                 | Cause                                      | Fix                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `Docker daemon is not reachable`                        | Docker not running                         | Start Docker, re-run                                                                                                  |
| Preflight fails on `PUBLISHER_MODE=github requires ...` | `.env` is in real mode without credentials | Set `EXECUTOR_MODE=mock` and `PUBLISHER_MODE=mock` in `.env`, or provide real `GITHUB_TOKEN` + `REPOSITORY_ALLOWLIST` |
| Preflight fails on `Invalid EXECUTOR_MODE="staged"`     | confused worker mode with runner pipeline  | use `EXECUTOR_MODE=gstack`; staged/single-pass is selected by ticket fields and `GSTACK_*_ARGS`                       |
| Migration error / wedged DB                             | stale/corrupt Postgres volume              | `npm run reset:db`                                                                                                    |
| API never becomes ready                                 | api container crash-looping                | `npm run logs`, read the error, fix `.env`, re-run setup                                                              |
| Port already in use (5432/6379/3000/5173)               | another process/stack bound the port       | fresh `.env` auto-bumps API/admin ports; otherwise change `HOST_API_PORT` / `HOST_ADMIN_PORT` in `.env`               |

## 2. Verify the stack

```bash
npm run status
```

Expected: all containers `running`/`healthy` and:

```
API readiness (http://localhost:3000/api/ready):
  HTTP 200 {"ok":true,"checks":{"database":"ok","redis":"ok"}}
```

If `.env` sets `HOST_API_PORT`, use that port in the expected URL. `npm run
status -- --strict` exits non-zero when the API, admin frontend, worker service,
or stale-image guard is unhealthy.

You can also probe directly:

```bash
curl -fsS http://localhost:3000/api/health   # {"ok":true}
curl -fsS http://localhost:3000/api/ready     # {"ok":true,"checks":{...}}
```

Authenticated admin API check (replace the token if you changed it):

```bash
curl -fsS http://localhost:3000/api/jobs -H "Authorization: Bearer change-me-admin-token"
# expect a JSON array (likely [] on a fresh database)
```

## 2a. If you changed `.env`, reload it

Most `.env` values are read at process start. After editing credentials, modes,
ports, `PUBLIC_BASE_URL`, or `REPOSITORY_ALLOWLIST`, run:

```bash
npm run doctor
docker compose up -d --force-recreate --wait api worker admin
```

If `EXECUTOR_MODE=gstack`, build the runtime image before recreating worker:

```bash
npm run docker:build-runtime
docker compose up -d --force-recreate --wait api worker admin
```

Then confirm:

```bash
npm run status
```

## 3. Run the code checks

```bash
npm run verify
```

Expected: format, typecheck, lint, tests, build, and secret scan all pass. The
mock e2e smoke is separate because it requires an already-running stack.

## 4. Common operations

```bash
npm run logs       # tail api + worker + admin logs (Ctrl-C to stop)
npm run down       # stop the stack (data preserved)
npm run setup      # bring it back up
npm run reset:db   # destructive: wipe the database volume and re-migrate
npm run doctor     # re-validate Docker + .env without touching the stack
npm run doctor:strict # fail on preflight warnings for real-mode readiness
```

## 5. Going beyond mock mode (optional)

Real GitHub PR publishing and a real agent runner require credentials and a
runner image. This is **not** needed for local development or the admin console.
See the "Environment", "Runner Image", and "Lark Status Write-back" sections of
the [README](../README.md), and run `npm run doctor` to confirm the required
variables are present before switching `EXECUTOR_MODE`/`PUBLISHER_MODE` away from
`mock`.

Use these mode values:

```dotenv
EXECUTOR_MODE=gstack
PUBLISHER_MODE=github
```

Do not set `EXECUTOR_MODE=staged`; staged is a per-ticket runner choice, not a
worker mode. Leave `GSTACK_ARGS` blank unless you intentionally want to force one
runner entrypoint for every job.

Before the first real run, make sure these paths exist on the host because the
worker passes them to `docker run` as bind mounts:

```bash
test -f "$HOME/.codex/auth.json"
test -f "$HOME/.codex/config.toml"
test -d "$HOME/.codex/skills"
mkdir -p "$HOME/gstack"  # or set GSTACK_SKILL_SOURCE_DIR to an existing checkout
```

The repository allowlist is an exact `owner/repo` string match. If policy fails
with `Repository is not allowlisted`, add the exact repository string to
`REPOSITORY_ALLOWLIST`, recreate API/worker, then retry the failed job from the
admin UI or:

```bash
curl -fsS -X POST "http://localhost:${HOST_API_PORT:-3000}/api/jobs/<job-id>/retry" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "content-type: application/json" \
  -d '{"guidance":"Repository allowlist updated; retry policy gate."}'
```

## 6. Exposing API webhooks through a tunnel

When Lark or GitHub must call your local API, point the tunnel at
`http://localhost:${HOST_API_PORT:-3000}` and set `PUBLIC_BASE_URL` to the public
HTTPS URL. For a temporary Cloudflare quick tunnel:

```bash
cloudflared tunnel --url "http://localhost:${HOST_API_PORT:-3000}" --no-autoupdate
```

After updating `PUBLIC_BASE_URL`, recreate API/worker. Lark webhook calls must
send the exact legacy header unless you implement the signed path on the sender:

```http
x-lark-webhook-secret: <LARK_WEBHOOK_SECRET>
```

## Definition of done

The setup is successful when:

1. `npm run status` shows the API `200` with `database: ok` and `redis: ok`.
2. `curl` of `/api/jobs` with the admin token returns a JSON array.
3. `npm run typecheck` and `npm test` both pass.
4. The admin console loads at `http://localhost:5173` and accepts the admin token.
