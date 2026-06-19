# AI Ticket-to-PR Agent Platform

Docker Compose MVP for turning approved Lark Base tickets into agent-generated
GitHub pull requests with an operations console for status, logs, artifacts,
retry, and cancel.

## Quickstart

```bash
cp .env.example .env
docker compose build
docker compose up -d postgres redis
npm --workspace @ticket-to-pr/db run migrate
docker compose up -d api worker
docker compose logs -f api worker
```

Open `http://localhost:3000` for the Admin UI and enter `ADMIN_TOKEN` from
`.env`.

## Health

```bash
curl http://localhost:3000/api/health
```

## Local Development

```bash
npm install
npm run typecheck
npm test
npm --workspace @ticket-to-pr/admin run build
```

Run the Admin UI directly during frontend work:

```bash
npm run dev:admin
```

## MVP Safety Boundary

The agent creates local commits and PR drafts. The platform owns policy gates,
push, and PR creation.

See [docs/operations.md](docs/operations.md) for Lark fields, required
environment variables, GitHub PAT scopes, smoke steps, retention, retry/cancel,
and security boundaries.
