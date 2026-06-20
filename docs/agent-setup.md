# PatchPilot Setup Runbook (for AI Agents)

This is a deterministic, copy-pasteable runbook for an AI coding agent (or any
automated environment) to set up PatchPilot from a fresh checkout and verify it
works. Follow the steps in order. Each step lists the command, the expected
result, and what to do on failure.

PatchPilot defaults to **mock mode** (no real Lark/GitHub credentials needed), so
the default `.env` is enough to get a working local stack and admin console.

## 0. Prerequisites (verify, do not assume)

```bash
node --version      # expect v20 or newer
docker info         # must succeed (Docker daemon running)
docker compose version
```

If `docker info` fails, the Docker daemon is not running — start Docker Desktop
(or the `docker` service) before continuing. Everything else is handled by the
setup script.

## 1. One-command setup

```bash
npm run setup
```

This runs, in order: preflight checks → create `.env` from `.env.example` if
missing → `npm install` → start and wait for Postgres + Redis → run migrations
with the **host** database URL → build and start the API + worker → wait for the
API readiness probe. It is idempotent; re-running is safe.

Expected tail of output:

```
✓ Setup complete.

  Admin console : http://localhost:3000
  Admin token   : change-me-admin-token
```

Use the printed `Admin token` to log into the console.

### If `npm run setup` fails

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Docker daemon is not reachable` | Docker not running | Start Docker, re-run |
| Preflight fails on `PUBLISHER_MODE=github requires ...` | `.env` is in real mode without credentials | Set `EXECUTOR_MODE=mock` and `PUBLISHER_MODE=mock` in `.env`, or provide real `GITHUB_TOKEN` + `REPOSITORY_ALLOWLIST` |
| Migration error / wedged DB | stale/corrupt Postgres volume | `npm run reset:db` |
| API never becomes ready | api container crash-looping | `npm run logs`, read the error, fix `.env`, re-run setup |
| Port already in use (5432/6379/3000) | another process/stack bound the port | stop it, or change `HOST_API_PORT` in `.env` for the API |

## 2. Verify the stack

```bash
npm run status
```

Expected: all containers `running`/`healthy` and:

```
API readiness (http://localhost:3000/api/ready):
  HTTP 200 {"ok":true,"checks":{"database":"ok","redis":"ok"}}
```

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

## 3. Run the code checks

```bash
npm run typecheck
npm test
```

Expected: typecheck prints nothing and exits 0; tests report all files passed
(one DB-integration test is skipped unless `DATABASE_URL` points at a live
Postgres — that is normal).

## 4. Common operations

```bash
npm run logs       # tail api + worker logs (Ctrl-C to stop)
npm run down       # stop the stack (data preserved)
npm run setup      # bring it back up
npm run reset:db   # destructive: wipe the database volume and re-migrate
npm run doctor     # re-validate Docker + .env without touching the stack
```

## 5. Going beyond mock mode (optional)

Real GitHub PR publishing and a real agent runner require credentials and a
runner image. This is **not** needed for local development or the admin console.
See the "Environment", "Runner Image", and "Lark Status Write-back" sections of
the [README](../README.md), and run `npm run doctor` to confirm the required
variables are present before switching `EXECUTOR_MODE`/`PUBLISHER_MODE` away from
`mock`.

## Definition of done

The setup is successful when:

1. `npm run status` shows the API `200` with `database: ok` and `redis: ok`.
2. `curl` of `/api/jobs` with the admin token returns a JSON array.
3. `npm run typecheck` and `npm test` both pass.
4. The admin console loads at `http://localhost:3000` and accepts the admin token.
