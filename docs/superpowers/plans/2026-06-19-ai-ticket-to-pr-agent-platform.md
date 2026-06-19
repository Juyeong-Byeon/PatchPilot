# AI Ticket-to-PR Agent Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Docker Compose MVP that receives a Lark Base ticket trigger, runs an isolated gstack/Claude job, validates the local commit, and lets the platform push/open a GitHub PR.

**Architecture:** Use an npm workspace monorepo with focused packages for core domain logic, persistence, queueing, runner contracts, API, worker, admin UI, and runner wrapper. Postgres is the source of truth, Redis/BullMQ is delivery, gstack/Claude creates local commits and PR drafts, and the platform owns policy gates plus remote publishing.

**Tech Stack:** TypeScript, Node.js 22, npm workspaces, Fastify, BullMQ, Postgres with `pg`, Redis, Zod, Vitest, React/Vite, Octokit, Docker Compose.

---

## Scope Check

The approved design has multiple components, but they form one end-to-end vertical slice. Implement in thin layers: core contracts first, then DB/API/queue, then mock executor, then Admin UI, then runner/gstack, then GitHub publishing. Each task below must compile and test before moving to the next task.

## File Structure

Create this structure:

```text
.
  package.json
  package-lock.json
  tsconfig.base.json
  vitest.config.ts
  .env.example
  .gitignore
  docker-compose.yml
  docker/
    api.Dockerfile
    worker.Dockerfile
    runner.Dockerfile
  packages/
    core/
      package.json
      src/
        branch.ts
        config.ts
        ids.ts
        lark.ts
        masking.ts
        policy.ts
        result-schema.ts
        state.ts
        types.ts
      test/
        branch.test.ts
        config.test.ts
        lark.test.ts
        masking.test.ts
        policy.test.ts
        result-schema.test.ts
        state.test.ts
    db/
      package.json
      src/
        client.ts
        migrate.ts
        repositories.ts
        schema.sql
        types.ts
      test/
        repositories.test.ts
    queue/
      package.json
      src/
        jobs.ts
        queue.ts
    runner-contract/
      package.json
      src/
        artifacts.ts
        workspace.ts
      test/
        workspace.test.ts
  apps/
    api/
      package.json
      src/
        auth.ts
        env.ts
        lark-webhook.ts
        routes-admin.ts
        routes-health.ts
        server.ts
      test/
        lark-webhook.test.ts
        routes-admin.test.ts
    worker/
      package.json
      src/
        env.ts
        executor-gstack.ts
        executor-mock.ts
        index.ts
        policy-gate.ts
        publisher-github.ts
        publisher-mock.ts
        worker.ts
      test/
        executor-mock.test.ts
        policy-gate.test.ts
        publisher-mock.test.ts
        worker.test.ts
    runner/
      package.json
      src/
        git.ts
        gstack.ts
        main.ts
        workspace.ts
      test/
        workspace.test.ts
    admin/
      package.json
      index.html
      src/
        App.tsx
        api.ts
        components/
          JobDetail.tsx
          JobList.tsx
          LogViewer.tsx
          RunTimeline.tsx
        main.tsx
        styles.css
      test/
        App.test.tsx
  docs/
    superpowers/
      specs/
        2026-06-19-ai-ticket-to-pr-agent-platform-design.md
      plans/
        2026-06-19-ai-ticket-to-pr-agent-platform.md
    operations.md
```

Responsibilities:

- `packages/core`: pure domain logic. No database, network, Docker, or filesystem side effects.
- `packages/db`: SQL schema, migrations, and repositories. Postgres is the state source of truth.
- `packages/queue`: BullMQ queue wrapper only. It never owns final state.
- `packages/runner-contract`: file paths and artifact read/write helpers shared by worker and runner.
- `apps/api`: Fastify server for Lark webhook, Admin REST API, and health.
- `apps/worker`: BullMQ consumer, executor dispatch, policy gate, publisher, state transitions.
- `apps/runner`: code that runs inside the fixed runner image.
- `apps/admin`: React operations console.

---

## Task 1: Bootstrap Monorepo and Tooling

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `vitest.config.ts`
- Create: `.env.example`
- Create: `.gitignore`
- Create: `docker-compose.yml`
- Create: `docker/api.Dockerfile`
- Create: `docker/worker.Dockerfile`
- Create: `docker/runner.Dockerfile`
- Create: package manifests under every workspace directory listed in File Structure

- [ ] **Step 1: Create root workspace manifest**

Create `package.json`:

```json
{
  "name": "ticket-to-pr",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "workspaces": [
    "packages/*",
    "apps/*"
  ],
  "scripts": {
    "build": "npm run build --workspaces",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -b --pretty false",
    "dev:api": "npm --workspace @ticket-to-pr/api run dev",
    "dev:worker": "npm --workspace @ticket-to-pr/worker run dev",
    "dev:admin": "npm --workspace @ticket-to-pr/admin run dev",
    "db:migrate": "npm --workspace @ticket-to-pr/db run migrate"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.7.2",
    "vite": "^6.0.3",
    "vitest": "^2.1.8"
  },
  "dependencies": {
    "@fastify/cors": "^10.0.2",
    "@fastify/static": "^8.0.3",
    "@octokit/rest": "^21.0.2",
    "bullmq": "^5.34.3",
    "fastify": "^5.1.0",
    "ioredis": "^5.4.2",
    "pg": "^8.13.1",
    "zod": "^3.24.1"
  }
}
```

- [ ] **Step 2: Create shared TypeScript and test config**

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist"
  }
}
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "apps/**/*.test.tsx"],
    environment: "node"
  }
});
```

- [ ] **Step 3: Create workspace package manifests**

Create this manifest for `packages/core/package.json`:

```json
{
  "name": "@ticket-to-pr/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

Create `packages/db/package.json`:

```json
{
  "name": "@ticket-to-pr/db",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "migrate": "node dist/migrate.js"
  },
  "dependencies": {
    "@ticket-to-pr/core": "0.1.0",
    "pg": "^8.13.1"
  },
  "devDependencies": {
    "@types/pg": "^8.11.10",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

Create `packages/queue/package.json`:

```json
{
  "name": "@ticket-to-pr/queue",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "bullmq": "^5.34.3"
  },
  "devDependencies": {
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

Create `packages/runner-contract/package.json`:

```json
{
  "name": "@ticket-to-pr/runner-contract",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

Create `apps/api/package.json`:

```json
{
  "name": "@ticket-to-pr/api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/server.js",
  "types": "dist/server.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "node --watch dist/server.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@ticket-to-pr/core": "0.1.0",
    "@ticket-to-pr/db": "0.1.0",
    "@ticket-to-pr/queue": "0.1.0",
    "fastify": "^5.1.0",
    "@fastify/cors": "^10.0.2",
    "@fastify/static": "^8.0.3"
  },
  "devDependencies": {
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

Create `apps/worker/package.json`:

```json
{
  "name": "@ticket-to-pr/worker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "node --watch dist/index.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@octokit/rest": "^21.0.2",
    "@ticket-to-pr/core": "0.1.0",
    "@ticket-to-pr/db": "0.1.0",
    "@ticket-to-pr/queue": "0.1.0",
    "@ticket-to-pr/runner-contract": "0.1.0",
    "bullmq": "^5.34.3"
  },
  "devDependencies": {
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

Create `apps/runner/package.json`:

```json
{
  "name": "@ticket-to-pr/runner",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/main.js",
  "types": "dist/main.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@ticket-to-pr/core": "0.1.0",
    "@ticket-to-pr/runner-contract": "0.1.0"
  },
  "devDependencies": {
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

Create each package `tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "test"]
}
```

For `apps/admin/package.json`, use:

```json
{
  "name": "@ticket-to-pr/admin",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build",
    "dev": "vite --host 0.0.0.0",
    "test": "vitest run --environment jsdom"
  },
  "dependencies": {
    "@vitejs/plugin-react": "^4.3.4",
    "vite": "^6.0.3",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@testing-library/react": "^16.1.0",
    "@testing-library/jest-dom": "^6.6.3",
    "jsdom": "^25.0.1",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 4: Create `.env.example`**

```dotenv
NODE_ENV=development
PUBLIC_BASE_URL=http://localhost:3000
ADMIN_TOKEN=change-me-admin-token
DATABASE_URL=postgres://ticket_to_pr:ticket_to_pr@postgres:5432/ticket_to_pr
REDIS_URL=redis://redis:6379
LARK_APP_ID=cli_xxx
LARK_APP_SECRET=secret_xxx
LARK_WEBHOOK_SECRET=webhook_secret_xxx
GITHUB_TOKEN=github_pat_xxx
REPOSITORY_ALLOWLIST=owner/repo
PROTECTED_PATH_DENYLIST=.env,.env.*,infra/**,terraform/**,secrets/**,migrations/prod/**
JOB_WORKSPACE_ROOT=/work/jobs
JOB_TIMEOUT_SECONDS=3600
FAILED_WORKSPACE_RETENTION_DAYS=7
EXECUTOR_MODE=mock
PUBLISHER_MODE=mock
RUNNER_IMAGE=ticket-to-pr-runner:local
```

- [ ] **Step 5: Create `.gitignore`**

```gitignore
node_modules/
dist/
.env
.DS_Store
.superpowers/
coverage/
work/
```

- [ ] **Step 6: Create Docker Compose**

Create `docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: ticket_to_pr
      POSTGRES_USER: ticket_to_pr
      POSTGRES_PASSWORD: ticket_to_pr
    ports:
      - "5432:5432"
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ticket_to_pr -d ticket_to_pr"]
      interval: 5s
      timeout: 3s
      retries: 20

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 20

  api:
    build:
      context: .
      dockerfile: docker/api.Dockerfile
    env_file: .env
    ports:
      - "3000:3000"
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

  worker:
    build:
      context: .
      dockerfile: docker/worker.Dockerfile
    env_file: .env
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./work:/work
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

volumes:
  postgres-data:
```

The worker mounts Docker socket only because the platform worker must launch job containers. The runner container must not receive Docker socket.

- [ ] **Step 7: Create Dockerfiles**

`docker/api.Dockerfile`:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm install
RUN npm run build --workspace @ticket-to-pr/core --workspace @ticket-to-pr/db --workspace @ticket-to-pr/queue --workspace @ticket-to-pr/api
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
```

`docker/worker.Dockerfile`:

```dockerfile
FROM node:22-alpine
RUN apk add --no-cache docker-cli git openssh-client
WORKDIR /app
COPY package*.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm install
RUN npm run build --workspace @ticket-to-pr/core --workspace @ticket-to-pr/db --workspace @ticket-to-pr/queue --workspace @ticket-to-pr/runner-contract --workspace @ticket-to-pr/worker
CMD ["node", "apps/worker/dist/index.js"]
```

`docker/runner.Dockerfile`:

```dockerfile
FROM node:22-alpine
RUN apk add --no-cache git openssh-client bash
RUN addgroup -S runner && adduser -S runner -G runner
WORKDIR /opt/runner
COPY package*.json /opt/runner/
COPY packages /opt/runner/packages
COPY apps/runner /opt/runner/apps/runner
RUN npm install
RUN npm run build --workspace @ticket-to-pr/core --workspace @ticket-to-pr/runner-contract --workspace @ticket-to-pr/runner
USER runner
CMD ["node", "apps/runner/dist/main.js"]
```

- [ ] **Step 8: Install dependencies**

Run:

```bash
npm install
```

Expected: `package-lock.json` is created and npm exits with code 0.

- [ ] **Step 9: Verify baseline**

Run:

```bash
npm test
npm run typecheck
```

Expected: no tests are found or all current tests pass; typecheck succeeds after the package manifests are valid.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json tsconfig.base.json vitest.config.ts .env.example .gitignore docker-compose.yml docker packages apps
git commit -m "chore: bootstrap ticket-to-pr workspace"
```

---

## Task 2: Core Domain Contracts

**Files:**
- Create: `packages/core/src/types.ts`
- Create: `packages/core/src/ids.ts`
- Create: `packages/core/src/branch.ts`
- Create: `packages/core/src/config.ts`
- Create: `packages/core/src/lark.ts`
- Create: `packages/core/src/state.ts`
- Create: `packages/core/src/masking.ts`
- Create: `packages/core/src/result-schema.ts`
- Create: `packages/core/src/policy.ts`
- Create: `packages/core/src/index.ts`
- Test: `packages/core/test/*.test.ts`

- [ ] **Step 1: Write branch generation tests**

Create `packages/core/test/branch.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createWorkBranchName } from "../src/branch.js";

describe("createWorkBranchName", () => {
  it("creates stable agent branch names", () => {
    expect(createWorkBranchName("rec123", "Fix Login Button")).toBe("agent/rec123-fix-login-button");
  });

  it("truncates long titles and appends attempt suffix", () => {
    expect(createWorkBranchName("rec123", "A".repeat(120), 3)).toBe(
      "agent/rec123-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-3"
    );
  });
});
```

- [ ] **Step 2: Implement branch generation**

Create `packages/core/src/branch.ts`:

```ts
export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "ticket";
}

export function createWorkBranchName(recordId: string, title: string, attempt?: number): string {
  const safeRecord = recordId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  const suffix = attempt && attempt > 1 ? `-${attempt}` : "";
  return `agent/${safeRecord}-${slugifyTitle(title)}${suffix}`;
}
```

- [ ] **Step 3: Write Lark trigger tests**

Create `packages/core/test/lark.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseLarkTicket, shouldCreateJobFromTicket } from "../src/lark.js";

const baseFields = {
  Title: "Fix login",
  Description: "Button should route to dashboard",
  "Definition of Done": "Clicking button opens dashboard",
  Repository: "acme/web",
  "Target Branch": "main",
  Priority: "Normal",
  Status: "Progress",
  "Agent Run Requested": true
};

describe("parseLarkTicket", () => {
  it("parses required fields", () => {
    const ticket = parseLarkTicket("rec1", "v1", baseFields);
    expect(ticket.repository).toBe("acme/web");
    expect(ticket.targetBranch).toBe("main");
  });

  it("rejects missing definition of done", () => {
    expect(() =>
      parseLarkTicket("rec1", "v1", { ...baseFields, "Definition of Done": "" })
    ).toThrow(/Definition of Done/);
  });
});

describe("shouldCreateJobFromTicket", () => {
  it("requires Progress and Agent Run Requested", () => {
    expect(shouldCreateJobFromTicket(parseLarkTicket("rec1", "v1", baseFields))).toBe(true);
    expect(
      shouldCreateJobFromTicket(parseLarkTicket("rec1", "v1", { ...baseFields, Status: "Todo" }))
    ).toBe(false);
  });
});
```

- [ ] **Step 4: Implement ticket parsing**

Create `packages/core/src/types.ts`:

```ts
export type Priority = "Low" | "Normal" | "High";

export type UserOutcome =
  | "Queued"
  | "Running"
  | "NeedsReview"
  | "FailedActionable"
  | "FailedInternal"
  | "Cancelled";

export type InternalPhase =
  | "Queued"
  | "Planning"
  | "Implementing"
  | "Reviewing"
  | "Testing"
  | "PolicyChecking"
  | "Publishing"
  | "Completed"
  | "Failed"
  | "CancelRequested"
  | "Cancelling"
  | "Cancelled"
  | "CancelFailed";

export interface TicketSnapshotInput {
  larkRecordId: string;
  triggerVersion: string;
  title: string;
  description: string;
  definitionOfDone: string;
  repository: string;
  targetBranch: string;
  priority: Priority;
  status: string;
  agentRunRequested: boolean;
  rawFields: Record<string, unknown>;
}
```

Create `packages/core/src/lark.ts`:

```ts
import { z } from "zod";
import type { TicketSnapshotInput } from "./types.js";

const prioritySchema = z.enum(["Low", "Normal", "High"]);

function requiredString(fields: Record<string, unknown>, name: string): string {
  const value = fields[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required Lark field: ${name}`);
  }
  return value.trim();
}

export function parseLarkTicket(
  larkRecordId: string,
  triggerVersion: string,
  fields: Record<string, unknown>
): TicketSnapshotInput {
  return {
    larkRecordId,
    triggerVersion,
    title: requiredString(fields, "Title"),
    description: requiredString(fields, "Description"),
    definitionOfDone: requiredString(fields, "Definition of Done"),
    repository: requiredString(fields, "Repository"),
    targetBranch: requiredString(fields, "Target Branch"),
    priority: prioritySchema.parse(fields.Priority),
    status: requiredString(fields, "Status"),
    agentRunRequested: fields["Agent Run Requested"] === true,
    rawFields: fields
  };
}

export function shouldCreateJobFromTicket(ticket: TicketSnapshotInput): boolean {
  return ticket.status === "Progress" && ticket.agentRunRequested === true;
}
```

- [ ] **Step 5: Write state transition tests**

Create `packages/core/test/state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deriveOutcome, transitionPhase } from "../src/state.js";

describe("transitionPhase", () => {
  it("allows queued to planning", () => {
    expect(transitionPhase("Queued", "Planning")).toBe("Planning");
  });

  it("blocks publishing before policy checking", () => {
    expect(() => transitionPhase("Testing", "Publishing")).toThrow(/Invalid phase transition/);
  });
});

describe("deriveOutcome", () => {
  it("maps active phase to Running", () => {
    expect(deriveOutcome("Testing")).toBe("Running");
  });

  it("maps completed phase to NeedsReview", () => {
    expect(deriveOutcome("Completed")).toBe("NeedsReview");
  });
});
```

- [ ] **Step 6: Implement state transitions**

Create `packages/core/src/state.ts`:

```ts
import type { InternalPhase, UserOutcome } from "./types.js";

const allowed: Record<InternalPhase, InternalPhase[]> = {
  Queued: ["Planning", "CancelRequested", "Failed"],
  Planning: ["Implementing", "CancelRequested", "Failed"],
  Implementing: ["Reviewing", "Testing", "CancelRequested", "Failed"],
  Reviewing: ["Testing", "CancelRequested", "Failed"],
  Testing: ["PolicyChecking", "CancelRequested", "Failed"],
  PolicyChecking: ["Publishing", "Failed"],
  Publishing: ["Completed", "Failed"],
  Completed: [],
  Failed: [],
  CancelRequested: ["Cancelling", "CancelFailed"],
  Cancelling: ["Cancelled", "CancelFailed"],
  Cancelled: [],
  CancelFailed: ["Failed"]
};

export function transitionPhase(current: InternalPhase, next: InternalPhase): InternalPhase {
  if (!allowed[current].includes(next)) {
    throw new Error(`Invalid phase transition: ${current} -> ${next}`);
  }
  return next;
}

export function deriveOutcome(phase: InternalPhase): UserOutcome {
  if (phase === "Queued") return "Queued";
  if (phase === "Completed") return "NeedsReview";
  if (phase === "Cancelled") return "Cancelled";
  if (phase === "Failed" || phase === "CancelFailed") return "FailedInternal";
  return "Running";
}
```

- [ ] **Step 7: Write result schema and masking tests**

Create `packages/core/test/result-schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseAgentResult } from "../src/result-schema.js";

describe("parseAgentResult", () => {
  it("accepts completed result with PR draft", () => {
    const result = parseAgentResult({
      schemaVersion: "1.0",
      runId: "run_1",
      jobId: "job_1",
      ticketId: "rec1",
      triggerVersion: "v1",
      status: "completed",
      targetBranch: "main",
      baseSha: "abc",
      headSha: "def",
      changedFiles: ["src/app.ts"],
      commits: [{ sha: "def", message: "Fix login" }],
      tests: [{ command: "npm test", status: "passed", summary: "ok" }],
      review: { summary: "reviewed", risks: [], knownLimitations: [] },
      pullRequestDraft: { title: "Fix login", bodyPath: "output/pr-body.md" },
      failure: null,
      retryable: false
    });
    expect(result.status).toBe("completed");
  });
});
```

Create `packages/core/test/masking.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { maskSecrets } from "../src/masking.js";

describe("maskSecrets", () => {
  it("masks GitHub tokens", () => {
    expect(maskSecrets("token github_pat_1234567890abcdef")).toContain("[REDACTED_GITHUB_TOKEN]");
  });
});
```

- [ ] **Step 8: Implement result schema and masking**

Create `packages/core/src/result-schema.ts`:

```ts
import { z } from "zod";

const testResultSchema = z.object({
  command: z.string().min(1),
  status: z.enum(["passed", "failed", "skipped"]),
  summary: z.string().min(1)
});

const failureSchema = z.object({
  stage: z.string().min(1),
  category: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  nextAction: z.string().min(1)
});

export const agentResultSchema = z.object({
  schemaVersion: z.literal("1.0"),
  runId: z.string().min(1),
  jobId: z.string().min(1),
  ticketId: z.string().min(1),
  triggerVersion: z.string().min(1),
  status: z.enum(["completed", "failed", "cancelled"]),
  targetBranch: z.string().min(1).optional(),
  baseSha: z.string().min(1).optional(),
  headSha: z.string().min(1).optional(),
  changedFiles: z.array(z.string()).default([]),
  commits: z.array(z.object({ sha: z.string().min(1), message: z.string().min(1) })).default([]),
  tests: z.array(testResultSchema).default([]),
  review: z
    .object({
      summary: z.string().min(1),
      risks: z.array(z.string()),
      knownLimitations: z.array(z.string())
    })
    .optional(),
  pullRequestDraft: z
    .object({
      title: z.string().min(1),
      bodyPath: z.string().min(1)
    })
    .optional(),
  failure: failureSchema.nullable(),
  retryable: z.boolean()
});

export type AgentResult = z.infer<typeof agentResultSchema>;

export function parseAgentResult(value: unknown): AgentResult {
  return agentResultSchema.parse(value);
}
```

Create `packages/core/src/masking.ts`:

```ts
const patterns: Array<[RegExp, string]> = [
  [/github_pat_[A-Za-z0-9_]+/g, "[REDACTED_GITHUB_TOKEN]"],
  [/ghp_[A-Za-z0-9_]+/g, "[REDACTED_GITHUB_TOKEN]"],
  [/(LARK_APP_SECRET=)[^\s]+/g, "$1[REDACTED_LARK_SECRET]"],
  [/(GITHUB_TOKEN=)[^\s]+/g, "$1[REDACTED_GITHUB_TOKEN]"]
];

export function maskSecrets(text: string): string {
  return patterns.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
}
```

- [ ] **Step 9: Implement policy helpers and config parsing**

Create `packages/core/src/policy.ts`:

```ts
export interface PolicyConfig {
  repositoryAllowlist: string[];
  protectedPathDenylist: string[];
}

export function isRepositoryAllowed(repository: string, allowlist: string[]): boolean {
  return allowlist.includes(repository);
}

export function isProtectedPath(path: string, denylist: string[]): boolean {
  return denylist.some((pattern) => {
    if (pattern.endsWith("/**")) return path.startsWith(pattern.slice(0, -3));
    if (pattern.endsWith(".*")) return path === pattern.slice(0, -2) || path.startsWith(pattern.slice(0, -1));
    return path === pattern;
  });
}
```

Create `packages/core/src/config.ts`:

```ts
export function parseCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
```

Create `packages/core/test/policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isProtectedPath, isRepositoryAllowed } from "../src/policy.js";

describe("policy helpers", () => {
  it("accepts allowlisted repositories only", () => {
    expect(isRepositoryAllowed("acme/web", ["acme/web"])).toBe(true);
    expect(isRepositoryAllowed("evil/web", ["acme/web"])).toBe(false);
  });

  it("matches protected path denylist entries", () => {
    expect(isProtectedPath("infra/main.tf", ["infra/**"])).toBe(true);
    expect(isProtectedPath(".env.local", [".env.*"])).toBe(true);
    expect(isProtectedPath("src/app.ts", ["infra/**", ".env.*"])).toBe(false);
  });
});
```

Create `packages/core/test/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/config.js";

describe("parseCsv", () => {
  it("trims empty entries", () => {
    expect(parseCsv("acme/web, acme/api,")).toEqual(["acme/web", "acme/api"]);
  });
});
```

- [ ] **Step 10: Export package API**

Create `packages/core/src/index.ts`:

```ts
export * from "./branch.js";
export * from "./config.js";
export * from "./lark.js";
export * from "./masking.js";
export * from "./policy.js";
export * from "./result-schema.js";
export * from "./state.js";
export * from "./types.js";
```

- [ ] **Step 11: Run tests and typecheck**

Run:

```bash
npm test --workspace @ticket-to-pr/core
npm run typecheck
```

Expected: all core tests pass and typecheck succeeds.

- [ ] **Step 12: Commit**

```bash
git add packages/core
git commit -m "feat: add core domain contracts"
```

---

## Task 3: Postgres Schema and Repositories

**Files:**
- Create: `packages/db/src/schema.sql`
- Create: `packages/db/src/client.ts`
- Create: `packages/db/src/migrate.ts`
- Create: `packages/db/src/types.ts`
- Create: `packages/db/src/repositories.ts`
- Create: `packages/db/src/index.ts`
- Test: `packages/db/test/repositories.test.ts`

- [ ] **Step 1: Create SQL schema**

Create `packages/db/src/schema.sql` with tables:

```sql
create table if not exists ticket_snapshots (
  id text primary key,
  lark_record_id text not null,
  trigger_version text not null,
  title text not null,
  description text not null,
  definition_of_done text not null,
  repository text not null,
  target_branch text not null,
  priority text not null,
  raw_fields jsonb not null,
  created_at timestamptz not null default now(),
  unique (lark_record_id, trigger_version)
);

create table if not exists jobs (
  id text primary key,
  ticket_snapshot_id text not null references ticket_snapshots(id),
  lark_record_id text not null,
  trigger_version text not null,
  idempotency_key text not null unique,
  outcome text not null,
  phase text not null,
  priority text not null,
  failure_category text,
  failure_reason text,
  next_action text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lark_record_id, trigger_version)
);

create unique index if not exists jobs_one_active_per_record
  on jobs(lark_record_id)
  where phase not in ('Completed', 'Failed', 'Cancelled', 'CancelFailed');

create table if not exists runs (
  id text primary key,
  job_id text not null references jobs(id),
  attempt integer not null,
  container_id text,
  runner_image_digest text,
  workspace_path text,
  base_sha text,
  work_branch text,
  head_sha text,
  exit_code integer,
  heartbeat_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  unique (job_id, attempt)
);

create table if not exists run_events (
  id bigserial primary key,
  job_id text not null references jobs(id),
  run_id text references runs(id),
  attempt integer,
  phase text not null,
  event_type text not null,
  source text not null,
  message text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists job_logs (
  id bigserial primary key,
  job_id text not null references jobs(id),
  run_id text references runs(id),
  source text not null,
  stream text not null,
  sequence integer not null,
  redaction_applied boolean not null default false,
  text text not null,
  created_at timestamptz not null default now()
);

create table if not exists artifacts (
  id text primary key,
  job_id text not null references jobs(id),
  run_id text references runs(id),
  kind text not null,
  path text,
  content jsonb,
  created_at timestamptz not null default now()
);

create table if not exists pull_requests (
  id text primary key,
  job_id text not null references jobs(id),
  run_id text not null references runs(id),
  repository text not null,
  target_branch text not null,
  work_branch text not null,
  base_sha text not null,
  head_sha text not null,
  commit_shas jsonb not null,
  pr_url text not null,
  pr_number integer not null,
  pr_title text not null,
  pr_body text not null,
  created_at timestamptz not null default now()
);

create table if not exists webhook_events (
  id text primary key,
  provider text not null,
  lark_record_id text,
  trigger_version text,
  payload jsonb not null,
  received_at timestamptz not null default now()
);

create table if not exists audit_events (
  id bigserial primary key,
  actor text not null,
  action text not null,
  job_id text references jobs(id),
  run_id text references runs(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
```

- [ ] **Step 2: Implement Postgres client and migration runner**

Create `packages/db/src/client.ts`:

```ts
import pg from "pg";

export type PgPool = pg.Pool;

export function createPool(connectionString: string): PgPool {
  return new pg.Pool({ connectionString });
}
```

Create `packages/db/src/migrate.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPool } from "./client.js";

const here = dirname(fileURLToPath(import.meta.url));

export async function migrate(connectionString: string): Promise<void> {
  const pool = createPool(connectionString);
  try {
    const sql = readFileSync(join(here, "schema.sql"), "utf8");
    await pool.query(sql);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  await migrate(connectionString);
}
```

- [ ] **Step 3: Implement repository methods**

Create `packages/db/src/repositories.ts` with these exports:

```ts
import type { PgPool } from "./client.js";
import type { TicketSnapshotInput, InternalPhase, UserOutcome } from "@ticket-to-pr/core";

export interface CreateJobResult {
  jobId: string;
  ticketSnapshotId: string;
  created: boolean;
}

export class Repositories {
  constructor(private readonly pool: PgPool) {}

  async createJobFromTicket(input: TicketSnapshotInput, ids: { ticketSnapshotId: string; jobId: string }): Promise<CreateJobResult> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const ticketInsert = await client.query<{ id: string }>(
        `insert into ticket_snapshots
         (id, lark_record_id, trigger_version, title, description, definition_of_done, repository, target_branch, priority, raw_fields)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (lark_record_id, trigger_version) do nothing
         returning id`,
        [
          ids.ticketSnapshotId,
          input.larkRecordId,
          input.triggerVersion,
          input.title,
          input.description,
          input.definitionOfDone,
          input.repository,
          input.targetBranch,
          input.priority,
          input.rawFields
        ]
      );
      const ticketSnapshotId =
        ticketInsert.rows[0]?.id ??
        (
          await client.query<{ id: string }>(
            `select id from ticket_snapshots where lark_record_id=$1 and trigger_version=$2`,
            [input.larkRecordId, input.triggerVersion]
          )
        ).rows[0]?.id;
      if (!ticketSnapshotId) throw new Error("Unable to resolve ticket snapshot id");
      const result = await client.query(
        `insert into jobs
         (id, ticket_snapshot_id, lark_record_id, trigger_version, idempotency_key, outcome, phase, priority)
         values ($1,$2,$3,$4,$5,'Queued','Queued',$6)
         on conflict (lark_record_id, trigger_version) do nothing
         returning id`,
        [
          ids.jobId,
          ticketSnapshotId,
          input.larkRecordId,
          input.triggerVersion,
          `${input.larkRecordId}:${input.triggerVersion}`,
          input.priority
        ]
      );
      await client.query("commit");
      return { jobId: ids.jobId, ticketSnapshotId, created: result.rowCount === 1 };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async transitionJob(jobId: string, phase: InternalPhase, outcome: UserOutcome, reason?: string): Promise<void> {
    await this.pool.query(
      `update jobs set phase=$2, outcome=$3, failure_reason=$4, updated_at=now() where id=$1`,
      [jobId, phase, outcome, reason ?? null]
    );
  }

  async appendEvent(input: { jobId: string; runId?: string; attempt?: number; phase: string; eventType: string; source: string; message: string; metadata?: unknown }): Promise<void> {
    await this.pool.query(
      `insert into run_events(job_id, run_id, attempt, phase, event_type, source, message, metadata)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [input.jobId, input.runId ?? null, input.attempt ?? null, input.phase, input.eventType, input.source, input.message, input.metadata ?? {}]
    );
  }
}
```

- [ ] **Step 4: Write repository integration test**

Create `packages/db/test/repositories.test.ts` using a real `DATABASE_URL` when present and skip otherwise:

```ts
import { describe, expect, it } from "vitest";
import { createPool } from "../src/client.js";
import { migrate } from "../src/migrate.js";
import { Repositories } from "../src/repositories.js";

const connectionString = process.env.DATABASE_URL;

describe.skipIf(!connectionString)("Repositories", () => {
  it("deduplicates jobs by lark record and trigger version", async () => {
    await migrate(connectionString!);
    const pool = createPool(connectionString!);
    const repos = new Repositories(pool);
    const ticket = {
      larkRecordId: `rec_${Date.now()}`,
      triggerVersion: "v1",
      title: "Fix login",
      description: "desc",
      definitionOfDone: "done",
      repository: "acme/web",
      targetBranch: "main",
      priority: "Normal" as const,
      status: "Progress",
      agentRunRequested: true,
      rawFields: {}
    };
    const first = await repos.createJobFromTicket(ticket, { ticketSnapshotId: "ts_1", jobId: "job_1" });
    const second = await repos.createJobFromTicket(ticket, { ticketSnapshotId: "ts_2", jobId: "job_2" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    await pool.end();
  });
});
```

- [ ] **Step 5: Export DB package API**

Create `packages/db/src/index.ts`:

```ts
export * from "./client.js";
export * from "./migrate.js";
export * from "./repositories.js";
```

- [ ] **Step 6: Run migration and tests**

Run:

```bash
docker compose up -d postgres
DATABASE_URL=postgres://ticket_to_pr:ticket_to_pr@localhost:5432/ticket_to_pr npm --workspace @ticket-to-pr/db run migrate
DATABASE_URL=postgres://ticket_to_pr:ticket_to_pr@localhost:5432/ticket_to_pr npm test --workspace @ticket-to-pr/db
npm run typecheck
```

Expected: migration completes, repository test passes, typecheck succeeds.

- [ ] **Step 7: Commit**

```bash
git add packages/db
git commit -m "feat: add postgres schema and repositories"
```

---

## Task 4: Lark Webhook API and Queue Delivery

**Files:**
- Create: `packages/queue/src/jobs.ts`
- Create: `packages/queue/src/queue.ts`
- Create: `packages/queue/src/index.ts`
- Create: `apps/api/src/env.ts`
- Create: `apps/api/src/auth.ts`
- Create: `apps/api/src/lark-webhook.ts`
- Create: `apps/api/src/routes-health.ts`
- Create: `apps/api/src/server.ts`
- Test: `apps/api/test/lark-webhook.test.ts`

- [ ] **Step 1: Implement queue wrapper**

Create `packages/queue/src/jobs.ts`:

```ts
export interface AgentJobPayload {
  jobId: string;
  ticketSnapshotId: string;
  larkRecordId: string;
  triggerVersion: string;
}

export const AGENT_JOB_QUEUE = "agent-jobs";
```

Create `packages/queue/src/queue.ts`:

```ts
import { Queue } from "bullmq";
import type { AgentJobPayload } from "./jobs.js";
import { AGENT_JOB_QUEUE } from "./jobs.js";

export function createAgentQueue(redisUrl: string): Queue<AgentJobPayload> {
  return new Queue<AgentJobPayload>(AGENT_JOB_QUEUE, { connection: { url: redisUrl } });
}
```

Create `packages/queue/src/index.ts`:

```ts
export * from "./jobs.js";
export * from "./queue.js";
```

- [ ] **Step 2: Write webhook handler test**

Create `apps/api/test/lark-webhook.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { handleLarkWebhook } from "../src/lark-webhook.js";

describe("handleLarkWebhook", () => {
  it("creates and enqueues a job when trigger conditions match", async () => {
    const repos = {
      createJobFromTicket: vi.fn().mockResolvedValue({ jobId: "job_1", ticketSnapshotId: "ts_1", created: true }),
      appendEvent: vi.fn()
    };
    const queue = { add: vi.fn().mockResolvedValue({ id: "bull_1" }) };
    const result = await handleLarkWebhook(
      {
        recordId: "rec1",
        triggerVersion: "v1",
        fields: {
          Title: "Fix login",
          Description: "desc",
          "Definition of Done": "done",
          Repository: "acme/web",
          "Target Branch": "main",
          Priority: "Normal",
          Status: "Progress",
          "Agent Run Requested": true
        }
      },
      repos as never,
      queue as never
    );
    expect(result.action).toBe("enqueued");
    expect(queue.add).toHaveBeenCalledWith("job_1", expect.objectContaining({ jobId: "job_1" }));
  });
});
```

- [ ] **Step 3: Implement webhook handler**

Create `apps/api/src/lark-webhook.ts`:

```ts
import { createWorkBranchName, parseLarkTicket, shouldCreateJobFromTicket } from "@ticket-to-pr/core";
import type { Repositories } from "@ticket-to-pr/db";
import type { Queue } from "bullmq";
import type { AgentJobPayload } from "@ticket-to-pr/queue";

export interface LarkWebhookInput {
  recordId: string;
  triggerVersion: string;
  fields: Record<string, unknown>;
}

export async function handleLarkWebhook(
  input: LarkWebhookInput,
  repos: Pick<Repositories, "createJobFromTicket" | "appendEvent">,
  queue: Pick<Queue<AgentJobPayload>, "add">
): Promise<{ action: "ignored" | "duplicate" | "enqueued"; jobId?: string }> {
  const ticket = parseLarkTicket(input.recordId, input.triggerVersion, input.fields);
  if (!shouldCreateJobFromTicket(ticket)) return { action: "ignored" };

  const jobId = `job_${crypto.randomUUID()}`;
  const ticketSnapshotId = `ts_${crypto.randomUUID()}`;
  const created = await repos.createJobFromTicket(ticket, { ticketSnapshotId, jobId });
  if (!created.created) return { action: "duplicate" };

  await queue.add(jobId, {
    jobId,
    ticketSnapshotId,
    larkRecordId: ticket.larkRecordId,
    triggerVersion: ticket.triggerVersion
  });
  await repos.appendEvent({
    jobId,
    phase: "Queued",
    eventType: "job.enqueued",
    source: "api",
    message: `Queued ${createWorkBranchName(ticket.larkRecordId, ticket.title)}`
  });
  return { action: "enqueued", jobId };
}
```

- [ ] **Step 4: Implement Fastify server and health route**

Create `apps/api/src/env.ts`, `routes-health.ts`, and `server.ts` so that:

```ts
// routes-health.ts
import type { FastifyInstance } from "fastify";

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => ({ ok: true }));
}
```

`server.ts` must create the pool, repositories, queue, register `POST /webhooks/lark`, register health, and listen on port `3000`.

- [ ] **Step 5: Run tests**

Run:

```bash
npm test --workspace @ticket-to-pr/api
npm run typecheck
```

Expected: webhook test passes and typecheck succeeds.

- [ ] **Step 6: Commit**

```bash
git add packages/queue apps/api
git commit -m "feat: add lark webhook API"
```

---

## Task 5: Worker, Mock Executor, and State Timeline

**Files:**
- Create: `apps/worker/src/env.ts`
- Create: `apps/worker/src/executor-mock.ts`
- Create: `apps/worker/src/worker.ts`
- Create: `apps/worker/src/index.ts`
- Modify: `packages/db/src/repositories.ts`
- Test: `apps/worker/test/executor-mock.test.ts`
- Test: `apps/worker/test/worker.test.ts`

- [ ] **Step 1: Add DB methods for run attempts, logs, artifacts, PR results**

Extend `Repositories` with:

```ts
createRun(input: { runId: string; jobId: string; attempt: number; workspacePath?: string }): Promise<void>
appendLog(input: { jobId: string; runId?: string; source: string; stream: string; sequence: number; text: string; redactionApplied: boolean }): Promise<void>
saveArtifact(input: { id: string; jobId: string; runId?: string; kind: string; path?: string; content?: unknown }): Promise<void>
savePullRequest(input: { id: string; jobId: string; runId: string; repository: string; targetBranch: string; workBranch: string; baseSha: string; headSha: string; commitShas: string[]; prUrl: string; prNumber: number; prTitle: string; prBody: string }): Promise<void>
```

Each method inserts into the corresponding table and throws on database errors.

- [ ] **Step 2: Write mock executor test**

Create `apps/worker/test/executor-mock.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runMockExecutor } from "../src/executor-mock.js";

describe("runMockExecutor", () => {
  it("returns a completed result with local commit evidence and PR draft", async () => {
    const result = await runMockExecutor({ jobId: "job_1", runId: "run_1", triggerVersion: "v1" });
    expect(result.status).toBe("completed");
    expect(result.commits).toHaveLength(1);
    expect(result.pullRequestDraft?.title).toContain("Mock");
  });
});
```

- [ ] **Step 3: Implement mock executor**

Create `apps/worker/src/executor-mock.ts`:

```ts
import type { AgentResult } from "@ticket-to-pr/core";

export async function runMockExecutor(input: {
  jobId: string;
  runId: string;
  triggerVersion: string;
}): Promise<AgentResult> {
  return {
    schemaVersion: "1.0",
    runId: input.runId,
    jobId: input.jobId,
    ticketId: "mock-ticket",
    triggerVersion: input.triggerVersion,
    status: "completed",
    targetBranch: "main",
    baseSha: "mock-base-sha",
    headSha: "mock-head-sha",
    changedFiles: ["mock/change.ts"],
    commits: [{ sha: "mock-head-sha", message: "Mock local commit" }],
    tests: [{ command: "mock test", status: "passed", summary: "Mock verification passed" }],
    review: { summary: "Mock self-review passed", risks: [], knownLimitations: [] },
    pullRequestDraft: { title: "Mock PR for Ticket-to-PR", bodyPath: "output/pr-body.md" },
    failure: null,
    retryable: false
  };
}
```

- [ ] **Step 4: Implement worker process path**

Create `apps/worker/src/worker.ts` to:

1. Create a run id and attempt.
2. Transition `Queued -> Planning`.
3. In `EXECUTOR_MODE=mock`, call `runMockExecutor`.
4. Save `result.json` as an artifact.
5. Transition through `PolicyChecking` and `Publishing`.
6. Use mock publisher in this task.
7. Save simulated PR metadata.
8. Transition to internal `Completed` with outcome `NeedsReview`.

- [ ] **Step 5: Run tests**

Run:

```bash
npm test --workspace @ticket-to-pr/worker
npm run typecheck
```

Expected: worker tests pass and typecheck succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/worker packages/db
git commit -m "feat: add worker mock execution"
```

---

## Task 6: Platform Policy Gate

**Files:**
- Create: `apps/worker/src/policy-gate.ts`
- Test: `apps/worker/test/policy-gate.test.ts`

- [ ] **Step 1: Write policy gate tests**

Create `apps/worker/test/policy-gate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { evaluatePolicyGate } from "../src/policy-gate.js";

describe("evaluatePolicyGate", () => {
  it("passes valid result and changed files", () => {
    const report = evaluatePolicyGate({
      repository: "acme/web",
      allowlist: ["acme/web"],
      targetBranch: "main",
      expectedTargetBranch: "main",
      workBranch: "agent/rec1-fix",
      expectedWorkBranch: "agent/rec1-fix",
      resultChangedFiles: ["src/app.ts"],
      gitChangedFiles: ["src/app.ts"],
      protectedPathDenylist: [".env", "infra/**"],
      hasLocalCommit: true,
      hasPrDraft: true,
      hasVerificationEvidence: true,
      runnerPushedRemote: false,
      secretScanFindings: []
    });
    expect(report.passed).toBe(true);
  });

  it("fails protected paths", () => {
    const report = evaluatePolicyGate({
      repository: "acme/web",
      allowlist: ["acme/web"],
      targetBranch: "main",
      expectedTargetBranch: "main",
      workBranch: "agent/rec1-fix",
      expectedWorkBranch: "agent/rec1-fix",
      resultChangedFiles: ["infra/main.tf"],
      gitChangedFiles: ["infra/main.tf"],
      protectedPathDenylist: ["infra/**"],
      hasLocalCommit: true,
      hasPrDraft: true,
      hasVerificationEvidence: true,
      runnerPushedRemote: false,
      secretScanFindings: []
    });
    expect(report.passed).toBe(false);
    expect(report.failures[0].code).toBe("protected_path");
  });
});
```

- [ ] **Step 2: Implement policy gate**

Create `apps/worker/src/policy-gate.ts`:

```ts
import { isProtectedPath, isRepositoryAllowed } from "@ticket-to-pr/core";

export interface PolicyGateInput {
  repository: string;
  allowlist: string[];
  targetBranch: string;
  expectedTargetBranch: string;
  workBranch: string;
  expectedWorkBranch: string;
  resultChangedFiles: string[];
  gitChangedFiles: string[];
  protectedPathDenylist: string[];
  hasLocalCommit: boolean;
  hasPrDraft: boolean;
  hasVerificationEvidence: boolean;
  runnerPushedRemote: boolean;
  secretScanFindings: string[];
}

export interface PolicyFailure {
  code: string;
  message: string;
}

export interface PolicyGateReport {
  passed: boolean;
  failures: PolicyFailure[];
}

export function evaluatePolicyGate(input: PolicyGateInput): PolicyGateReport {
  const failures: PolicyFailure[] = [];
  if (!isRepositoryAllowed(input.repository, input.allowlist)) {
    failures.push({ code: "repository_not_allowed", message: `Repository is not allowlisted: ${input.repository}` });
  }
  if (input.targetBranch !== input.expectedTargetBranch) {
    failures.push({ code: "target_branch_mismatch", message: "Target branch changed during execution" });
  }
  if (input.workBranch !== input.expectedWorkBranch) {
    failures.push({ code: "work_branch_mismatch", message: "Work branch does not match platform branch" });
  }
  if (!input.hasLocalCommit) failures.push({ code: "missing_commit", message: "No local commit was produced" });
  if (!input.hasPrDraft) failures.push({ code: "missing_pr_draft", message: "PR title or body draft is missing" });
  if (!input.hasVerificationEvidence) {
    failures.push({ code: "missing_verification", message: "Verification evidence is missing" });
  }
  if (input.runnerPushedRemote) {
    failures.push({ code: "runner_remote_push", message: "Runner pushed to remote before platform gate" });
  }
  for (const path of input.gitChangedFiles) {
    if (isProtectedPath(path, input.protectedPathDenylist)) {
      failures.push({ code: "protected_path", message: `Protected path changed: ${path}` });
    }
  }
  const resultSet = new Set(input.resultChangedFiles);
  for (const path of input.gitChangedFiles) {
    if (!resultSet.has(path)) {
      failures.push({ code: "changed_files_mismatch", message: `Git changed file missing from result: ${path}` });
    }
  }
  for (const finding of input.secretScanFindings) {
    failures.push({ code: "secret_scan", message: finding });
  }
  return { passed: failures.length === 0, failures };
}
```

- [ ] **Step 3: Integrate policy gate into worker**

Modify `apps/worker/src/worker.ts` so mock mode builds a `PolicyGateReport`, saves it as artifact kind `policy_gate_report`, and blocks publishing when `passed` is false.

- [ ] **Step 4: Run tests**

Run:

```bash
npm test --workspace @ticket-to-pr/worker -- policy-gate
npm run typecheck
```

Expected: policy gate tests pass and typecheck succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/worker
git commit -m "feat: enforce policy gate before publishing"
```

---

## Task 7: Admin REST API and Operations UI

**Files:**
- Create: `apps/api/src/auth.ts`
- Create: `apps/api/src/routes-admin.ts`
- Modify: `apps/api/src/server.ts`
- Create: `apps/admin/src/api.ts`
- Create: `apps/admin/src/App.tsx`
- Create: `apps/admin/src/components/JobList.tsx`
- Create: `apps/admin/src/components/JobDetail.tsx`
- Create: `apps/admin/src/components/RunTimeline.tsx`
- Create: `apps/admin/src/components/LogViewer.tsx`
- Create: `apps/admin/src/styles.css`
- Test: `apps/api/test/routes-admin.test.ts`
- Test: `apps/admin/test/App.test.tsx`

- [ ] **Step 1: Implement admin token auth**

Create `apps/api/src/auth.ts`:

```ts
import type { FastifyRequest } from "fastify";

export function assertAdminToken(request: FastifyRequest, expectedToken: string): void {
  const header = request.headers.authorization;
  if (header !== `Bearer ${expectedToken}`) {
    const error = new Error("Unauthorized");
    Object.assign(error, { statusCode: 401 });
    throw error;
  }
}
```

- [ ] **Step 2: Add repository read methods**

Add methods to `Repositories`:

```ts
listJobs(): Promise<Array<Record<string, unknown>>>
getJob(jobId: string): Promise<Record<string, unknown> | null>
getJobEvents(jobId: string): Promise<Array<Record<string, unknown>>>
getJobLogs(jobId: string): Promise<Array<Record<string, unknown>>>
getJobArtifacts(jobId: string): Promise<Array<Record<string, unknown>>>
```

Each method uses parameterized SQL and orders timelines/logs by creation time and sequence.

- [ ] **Step 3: Implement admin routes**

Create `apps/api/src/routes-admin.ts` with:

```ts
import type { FastifyInstance } from "fastify";
import type { Repositories } from "@ticket-to-pr/db";
import { assertAdminToken } from "./auth.js";

export async function registerAdminRoutes(app: FastifyInstance, repos: Repositories, adminToken: string): Promise<void> {
  app.addHook("preHandler", async (request) => {
    if (request.url.startsWith("/api/jobs")) assertAdminToken(request, adminToken);
  });
  app.get("/api/jobs", async () => repos.listJobs());
  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (request, reply) => {
    const job = await repos.getJob(request.params.id);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    return job;
  });
  app.get<{ Params: { id: string } }>("/api/jobs/:id/events", async (request) => repos.getJobEvents(request.params.id));
  app.get<{ Params: { id: string } }>("/api/jobs/:id/logs", async (request) => repos.getJobLogs(request.params.id));
  app.get<{ Params: { id: string } }>("/api/jobs/:id/artifacts", async (request) => repos.getJobArtifacts(request.params.id));
}
```

- [ ] **Step 4: Implement Admin UI components**

Create React components with these visible sections:

- `JobList`: triage table with outcome, phase, repository, target branch, runtime, last event, PR link.
- `JobDetail`: header with outcome, error summary, next action, retry/cancel buttons.
- `RunTimeline`: ordered run events.
- `LogViewer`: source filter, text search, copy/download buttons.

The UI must use small, dense operational layouts with no marketing hero.

- [ ] **Step 5: Add Admin UI tests**

Create `apps/admin/test/App.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import App from "../src/App.js";

describe("App", () => {
  it("renders operations console", () => {
    render(<App />);
    expect(screen.getByText(/Ticket-to-PR Operations/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run tests and build**

Run:

```bash
npm test --workspace @ticket-to-pr/api
npm test --workspace @ticket-to-pr/admin
npm --workspace @ticket-to-pr/admin run build
npm run typecheck
```

Expected: API tests pass, Admin tests pass, Admin build succeeds, typecheck succeeds.

- [ ] **Step 7: Commit**

```bash
git add apps/api apps/admin packages/db
git commit -m "feat: add admin operations console"
```

---

## Task 8: Runner Contract and Fixed Runner Image

**Files:**
- Create: `packages/runner-contract/src/workspace.ts`
- Create: `packages/runner-contract/src/artifacts.ts`
- Create: `packages/runner-contract/src/index.ts`
- Create: `apps/runner/src/git.ts`
- Create: `apps/runner/src/gstack.ts`
- Create: `apps/runner/src/workspace.ts`
- Create: `apps/runner/src/main.ts`
- Test: `packages/runner-contract/test/workspace.test.ts`
- Test: `apps/runner/test/workspace.test.ts`

- [ ] **Step 1: Write workspace path tests**

Create `packages/runner-contract/test/workspace.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getWorkspacePaths } from "../src/workspace.js";

describe("getWorkspacePaths", () => {
  it("returns stable artifact paths", () => {
    const paths = getWorkspacePaths("/work/jobs/job_1");
    expect(paths.ticketMd).toBe("/work/jobs/job_1/input/ticket.md");
    expect(paths.resultJson).toBe("/work/jobs/job_1/output/result.json");
  });
});
```

- [ ] **Step 2: Implement workspace paths**

Create `packages/runner-contract/src/workspace.ts`:

```ts
import { join } from "node:path";

export function getWorkspacePaths(root: string) {
  return {
    root,
    inputDir: join(root, "input"),
    repoDir: join(root, "repo"),
    outputDir: join(root, "output"),
    logsDir: join(root, "logs"),
    ticketMd: join(root, "input", "ticket.md"),
    contextJson: join(root, "input", "context.json"),
    policyJson: join(root, "input", "policy.json"),
    resultJson: join(root, "output", "result.json"),
    prTitle: join(root, "output", "pr-title.txt"),
    prBody: join(root, "output", "pr-body.md")
  };
}
```

- [ ] **Step 3: Implement runner git helpers**

Create `apps/runner/src/git.ts` with functions:

```ts
runGit(args: string[], cwd: string): Promise<string>
cloneRepository(repositoryUrl: string, targetDir: string): Promise<void>
checkoutBaseAndCreateBranch(repoDir: string, targetBranch: string, workBranch: string): Promise<{ baseSha: string }>
getHeadSha(repoDir: string): Promise<string>
hasLocalCommit(repoDir: string, baseSha: string): Promise<boolean>
getChangedFiles(repoDir: string, baseSha: string): Promise<string[]>
```

Use `node:child_process` `spawn` and reject on non-zero exit.

- [ ] **Step 4: Implement gstack invocation**

Create `apps/runner/src/gstack.ts`:

```ts
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

export async function runGstack(repoDir: string, logPath: string, timeoutMs: number): Promise<number> {
  return await new Promise((resolve, reject) => {
    const log = createWriteStream(logPath, { flags: "a" });
    const command = process.env.GSTACK_COMMAND ?? "gstack";
    const args = (process.env.GSTACK_ARGS ?? "ship --no-push").split(" ");
    const child = spawn(command, args, { cwd: repoDir, env: process.env });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      log.end();
      resolve(code ?? 1);
    });
  });
}
```

The configured gstack command must not push or create a PR. If `GSTACK_COMMAND` or `GSTACK_ARGS` violates that contract, the runner fails the job during policy verification because `runnerPushedRemote` becomes true or required local artifacts are missing.

- [ ] **Step 5: Implement runner main**

`apps/runner/src/main.ts` must:

1. Read env vars: `JOB_ID`, `RUN_ID`, `WORKSPACE_ROOT`, `REPOSITORY_URL`, `TARGET_BRANCH`, `WORK_BRANCH`, `TIMEOUT_SECONDS`.
2. Create input/output/log directories.
3. Clone repo.
4. Checkout target branch and create work branch.
5. Run gstack.
6. Verify `output/result.json`, `output/pr-title.txt`, and `output/pr-body.md`.
7. Verify local commits exist after base SHA.
8. Exit non-zero if required artifacts are missing.

- [ ] **Step 6: Build runner image**

Run:

```bash
docker build -f docker/runner.Dockerfile -t ticket-to-pr-runner:local .
```

Expected: image builds and the final image runs as non-root user.

- [ ] **Step 7: Run tests and typecheck**

```bash
npm test --workspace @ticket-to-pr/runner-contract
npm test --workspace @ticket-to-pr/runner
npm run typecheck
```

Expected: tests pass and typecheck succeeds.

- [ ] **Step 8: Commit**

```bash
git add packages/runner-contract apps/runner docker/runner.Dockerfile
git commit -m "feat: add fixed runner contract"
```

---

## Task 9: gstack Executor from Worker

**Files:**
- Create: `apps/worker/src/executor-gstack.ts`
- Modify: `apps/worker/src/worker.ts`
- Test: `apps/worker/test/executor-gstack.test.ts`

- [ ] **Step 1: Implement Docker runner launcher**

Create `apps/worker/src/executor-gstack.ts` with:

```ts
export interface GstackExecutorInput {
  jobId: string;
  runId: string;
  workspaceRoot: string;
  repositoryUrl: string;
  targetBranch: string;
  workBranch: string;
  runnerImage: string;
  timeoutSeconds: number;
}

export interface GstackExecutorResult {
  containerId?: string;
  exitCode: number;
  workspacePath: string;
}
```

Implement `runGstackExecutor(input)` using `docker run --rm` with:

- `--network none` for MVP default unless dependency installation is required by the repo.
- `--cpus 2`
- `--memory 4g`
- `-v <workspacePath>:/work/jobs/<job-id>`
- Env vars from `GstackExecutorInput`.
- No Docker socket mount.

- [ ] **Step 2: Write executor command construction test**

Test that the Docker args include workspace mount, runner image, no Docker socket, and required env vars.

- [ ] **Step 3: Integrate executor mode switch**

Modify `apps/worker/src/worker.ts`:

- `EXECUTOR_MODE=mock` uses `runMockExecutor`.
- `EXECUTOR_MODE=gstack` uses `runGstackExecutor`, reads `result.json`, reads PR title/body, gathers changed files from git, then runs policy gate.

- [ ] **Step 4: Run tests**

```bash
npm test --workspace @ticket-to-pr/worker -- executor-gstack
npm run typecheck
```

Expected: executor tests pass and typecheck succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/worker
git commit -m "feat: run gstack through isolated runner"
```

---

## Task 10: Platform GitHub Publisher

**Files:**
- Create: `apps/worker/src/publisher-github.ts`
- Create: `apps/worker/src/publisher-mock.ts`
- Modify: `apps/worker/src/worker.ts`
- Test: `apps/worker/test/publisher-mock.test.ts`
- Test: `apps/worker/test/publisher-github.test.ts`

- [ ] **Step 1: Implement publisher interface**

Create `apps/worker/src/publisher-mock.ts`:

```ts
export interface PublishInput {
  repository: string;
  targetBranch: string;
  workBranch: string;
  baseSha: string;
  headSha: string;
  commitShas: string[];
  prTitle: string;
  prBody: string;
  runFooter: string;
}

export interface PublishResult {
  prUrl: string;
  prNumber: number;
  prTitle: string;
  prBody: string;
}

export async function publishMock(input: PublishInput): Promise<PublishResult> {
  return {
    prUrl: `https://github.example/${input.repository}/pull/mock`,
    prNumber: 1,
    prTitle: input.prTitle,
    prBody: `${input.prBody}\n\n${input.runFooter}`
  };
}
```

- [ ] **Step 2: Implement GitHub publisher**

Create `apps/worker/src/publisher-github.ts`:

```ts
import { Octokit } from "@octokit/rest";
import type { PublishInput, PublishResult } from "./publisher-mock.js";

export async function publishGitHub(input: PublishInput, token: string): Promise<PublishResult> {
  const [owner, repo] = input.repository.split("/");
  if (!owner || !repo) throw new Error(`Invalid GitHub repository: ${input.repository}`);
  const octokit = new Octokit({ auth: token });
  const body = `${input.prBody}\n\n${input.runFooter}`;
  const pr = await octokit.pulls.create({
    owner,
    repo,
    head: input.workBranch,
    base: input.targetBranch,
    title: input.prTitle,
    body
  });
  return {
    prUrl: pr.data.html_url,
    prNumber: pr.data.number,
    prTitle: pr.data.title,
    prBody: body
  };
}
```

The branch push is performed by worker git command before `publishGitHub`, after policy gate passes.

- [ ] **Step 3: Add publisher mode switch**

Worker uses:

- `PUBLISHER_MODE=mock`: `publishMock`.
- `PUBLISHER_MODE=github`: push branch and call `publishGitHub`.

- [ ] **Step 4: Add tests**

Test mock publisher body footer append. Test GitHub publisher with a mocked Octokit module and verify base/head/title/body.

- [ ] **Step 5: Run tests and typecheck**

```bash
npm test --workspace @ticket-to-pr/worker -- publisher
npm run typecheck
```

Expected: publisher tests pass and typecheck succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/worker
git commit -m "feat: publish pull requests from platform"
```

---

## Task 11: Retry, Cancel, and Audit Events

**Files:**
- Modify: `apps/api/src/routes-admin.ts`
- Modify: `apps/worker/src/worker.ts`
- Modify: `packages/db/src/repositories.ts`
- Test: `apps/api/test/routes-admin.test.ts`
- Test: `apps/worker/test/worker.test.ts`

- [ ] **Step 1: Add DB methods**

Add:

```ts
requestCancel(jobId: string, actor: string): Promise<void>
createRetryAttempt(jobId: string, actor: string): Promise<{ runId: string; attempt: number }>
appendAuditEvent(input: { actor: string; action: string; jobId?: string; runId?: string; metadata?: unknown }): Promise<void>
getRetryPreflight(jobId: string): Promise<Record<string, unknown>>
```

- [ ] **Step 2: Implement Admin cancel route**

`POST /api/jobs/:id/cancel`:

- Requires admin token.
- Writes audit event.
- Sets internal phase `CancelRequested`.
- Returns `{ ok: true, phase: "CancelRequested" }`.

- [ ] **Step 3: Implement Admin retry route**

`POST /api/jobs/:id/retry`:

- Requires admin token.
- Reads retry preflight.
- Creates new attempt only for terminal jobs.
- Writes audit event.
- Enqueues BullMQ payload for the existing job id and new attempt.

- [ ] **Step 4: Worker cancel behavior**

Worker checks cancel before each major phase. If cancel is requested before publishing, it stops execution and transitions to `Cancelled`. During publishing, it records cancel as best effort and does not delete pushed branches or PRs.

- [ ] **Step 5: Run tests**

```bash
npm test --workspace @ticket-to-pr/api -- routes-admin
npm test --workspace @ticket-to-pr/worker -- worker
npm run typecheck
```

Expected: retry/cancel tests pass and typecheck succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/api apps/worker packages/db
git commit -m "feat: add retry cancel and audit events"
```

---

## Task 12: Docker Compose Smoke and Operator Docs

**Files:**
- Modify: `docker-compose.yml`
- Create: `docs/operations.md`
- Modify: `README.md`
- Test: manual Docker smoke commands

- [ ] **Step 1: Create operations doc**

Create `docs/operations.md` with:

- Required Lark fields.
- Required `.env` values.
- GitHub fine-grained PAT scope: selected repo, Contents read/write, Pull requests read/write.
- Docker Compose startup.
- Health check.
- Mock executor smoke.
- Real executor smoke.
- Failure workspace retention.
- Retry/cancel behavior.
- Security boundaries.

- [ ] **Step 2: Create README quickstart**

Create `README.md`:

```md
# AI Ticket-to-PR Agent Platform

## Quickstart

```bash
cp .env.example .env
docker compose up -d
docker compose logs -f api worker
```

Open `http://localhost:3000` for the Admin UI.

## Health

```bash
curl http://localhost:3000/api/health
```

## MVP Safety Boundary

The agent creates local commits and PR drafts. The platform owns policy gates, push, and PR creation.
```
```

- [ ] **Step 3: Run Docker smoke**

Run:

```bash
cp .env.example .env
docker compose build
docker compose up -d postgres redis
npm --workspace @ticket-to-pr/db run migrate
docker compose up -d api worker
curl -fsS http://localhost:3000/api/health
```

Expected: health returns JSON with `ok: true`.

- [ ] **Step 4: Run full verification**

Run:

```bash
npm test
npm run typecheck
npm run build
```

Expected: all tests pass, typecheck succeeds, all packages build.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/operations.md docker-compose.yml
git commit -m "docs: add operations quickstart"
```

---

## Final Verification

After all tasks are implemented:

- [ ] Run `npm test`
- [ ] Run `npm run typecheck`
- [ ] Run `npm run build`
- [ ] Run `docker compose build`
- [ ] Run `docker compose up -d`
- [ ] Run `curl -fsS http://localhost:3000/api/health`
- [ ] Create a mock Lark webhook and verify the job reaches `NeedsReview` in Admin UI.
- [ ] Confirm `.superpowers/` is not tracked.
- [ ] Confirm no secrets are printed in logs.

Expected final state:

- Lark webhook path can create an idempotent job.
- BullMQ delivers work to the worker.
- Mock executor can complete end-to-end without GitHub access.
- gstack executor can run in a fixed runner image.
- Platform policy gate blocks unsafe changes before publishing.
- Platform publisher owns push and PR creation.
- Admin UI exposes run timeline, errors, artifacts, logs, retry, and cancel.
