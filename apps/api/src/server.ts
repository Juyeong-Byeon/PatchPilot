import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createLarkRecordUpdater, type LarkStatusUpdater } from "@ticket-to-pr/core";
import fastifyStatic from "@fastify/static";
import { createPool, Repositories } from "@ticket-to-pr/db";
import { createAgentQueue } from "@ticket-to-pr/queue";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { assertGitHubWebhookSignature, createLarkWebhookVerifier } from "./auth.js";
import { readApiEnv } from "./env.js";
import {
  handleGitHubPullRequestWebhook,
  parseGitHubPullRequestPayload,
  type GitHubWebhookRepositories,
} from "./github-webhook.js";
import { handleLarkWebhook, parseLarkWebhookInput, type AgentQueue } from "./lark-webhook.js";
import { registerAdminRoutes, type AdminRepositories } from "./routes-admin.js";
import { registerHealthRoutes, type HealthProbes } from "./routes-health.js";
import { registerSettingsRoutes, type SettingsRepositories } from "./routes-settings.js";
import { registerVersionRoutes } from "./routes-version.js";

export interface ApiServerDependencies {
  repos: Pick<Repositories, "createJobFromTicket" | "appendEvent"> &
    Partial<AdminRepositories> &
    Partial<GitHubWebhookRepositories> &
    Partial<SettingsRepositories>;
  queue: AgentQueue;
  adminToken?: string;
  larkWebhookSecret?: string;
  /** Clock-skew / replay window (seconds) for signed Lark webhooks. Default 300. */
  larkReplayWindowSeconds?: number;
  githubWebhookSecret?: string | undefined;
  allowUnauthenticatedLarkWebhook?: boolean;
  allowUnauthenticatedGitHubWebhook?: boolean;
  larkUpdater?: LarkStatusUpdater | undefined;
  adminStaticRoot?: string;
  healthProbes?: HealthProbes;
}

export async function buildServer(deps: ApiServerDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  installRawJsonBodyParser(app);
  const larkWebhookSecret = deps.larkWebhookSecret?.trim();
  if (!larkWebhookSecret && deps.allowUnauthenticatedLarkWebhook !== true) {
    throw new Error("Lark webhook secret is required");
  }
  // Built once so the replay/nonce cache (L5) is shared across all requests for
  // the lifetime of the server. Undefined only in the explicit unauthenticated
  // test/dev bypass, in which case the route skips verification entirely.
  const larkVerifier = larkWebhookSecret
    ? createLarkWebhookVerifier({
        secret: larkWebhookSecret,
        replayWindowSeconds: deps.larkReplayWindowSeconds,
      })
    : undefined;

  await registerHealthRoutes(app, deps.healthProbes);
  await registerVersionRoutes(app);
  if (deps.adminToken && hasAdminRepositories(deps.repos)) {
    await registerAdminRoutes(app, deps.repos, deps.queue, deps.adminToken);
  }
  // Settings routes require the admin token like /api/jobs. Registered only when the
  // repository provides the settings methods so an older backend omits the routes and
  // the admin degrades to a graceful 404.
  if (deps.adminToken && hasSettingsRepositories(deps.repos)) {
    await registerSettingsRoutes(app, deps.repos, deps.adminToken);
  }
  app.post<{ Body: unknown }>("/webhooks/lark", async (request, reply) => {
    // Hardened verifier (L5): prefers signed (HMAC + timestamp + nonce) requests,
    // falls back to the legacy plain `x-lark-webhook-secret` header for
    // back-compat. Needs the exact raw body bytes for the HMAC.
    if (larkVerifier) larkVerifier.verify(request, readRawBody(request));
    // Runtime shape check on top of the HMAC: an authentic but malformed body is
    // rejected with 400 before it reaches `parseLarkTicket`, never a 500.
    const input = parseLarkWebhookInput(request.body);
    if (!input) return reply.code(400).send({ error: "Invalid Lark webhook payload" });
    const result = await handleLarkWebhook(input, deps.repos, deps.queue, deps.larkUpdater);
    const statusCode = result.action === "enqueued" ? 202 : 200;
    return reply.code(statusCode).send(result);
  });
  const githubWebhookSecret = deps.githubWebhookSecret?.trim();
  if (githubWebhookSecret || deps.allowUnauthenticatedGitHubWebhook === true) {
    app.post<{ Body: unknown }>("/webhooks/github", async (request, reply) => {
      if (githubWebhookSecret) assertGitHubWebhookSignature(request, githubWebhookSecret, readRawBody(request));
      if (request.headers["x-github-event"] !== "pull_request") return reply.code(200).send({ action: "ignored" });
      if (!hasGitHubWebhookRepositories(deps.repos))
        return reply.code(503).send({ error: "GitHub webhook repository unavailable" });

      // Runtime shape check on top of the HMAC, replacing `request.body as never`.
      // A body that is not a shape-valid pull_request payload maps to the same
      // safe "ignored"/200 response GitHub already gets for events it does not act
      // on — never a 500.
      const payload = parseGitHubPullRequestPayload(request.body);
      if (!payload) return reply.code(200).send({ action: "ignored" });

      // Pass the GitHub delivery id so the handler can dedup redeliveries exactly
      // once (T2). The header is single-valued; coerce an array form defensively.
      const deliveryHeader = request.headers["x-github-delivery"];
      const deliveryId = Array.isArray(deliveryHeader) ? deliveryHeader[0] : deliveryHeader;
      const result = await handleGitHubPullRequestWebhook(payload, deps.repos, deps.larkUpdater, {
        deliveryId,
      });
      const statusCode = result.action === "completed" ? 202 : 200;
      return reply.code(statusCode).send(result);
    });
  }
  if (deps.adminStaticRoot && existsSync(deps.adminStaticRoot)) {
    await app.register(fastifyStatic, {
      root: deps.adminStaticRoot,
      prefix: "/",
    });
    // SPA fallback: a full-page load of a client route (e.g. /jobs/:id on reload,
    // bookmark, or shared link) must return index.html, not a JSON 404. API and
    // webhook misses stay real 404s so callers still get a machine-readable error.
    if (existsSync(join(deps.adminStaticRoot, "index.html"))) {
      app.setNotFoundHandler((request, reply) => {
        if (request.method === "GET" && !request.url.startsWith("/api") && !request.url.startsWith("/webhooks")) {
          return reply.type("text/html").sendFile("index.html");
        }
        return reply
          .code(404)
          .send({ message: `Route ${request.method}:${request.url} not found`, error: "Not Found", statusCode: 404 });
      });
    }
  }

  return app;
}

export async function startServer(): Promise<void> {
  const env = readApiEnv();
  const pool = createPool(env.databaseUrl);
  const queue = createAgentQueue(env.redisUrl);
  const app = await buildServer({
    repos: new Repositories(pool),
    queue,
    adminToken: env.adminToken,
    larkWebhookSecret: env.larkWebhookSecret,
    githubWebhookSecret: env.githubWebhookSecret,
    larkUpdater: env.larkRecordUpdaterConfig ? createLarkRecordUpdater(env.larkRecordUpdaterConfig) : undefined,
    adminStaticRoot: join(process.cwd(), "apps/admin/dist"),
    healthProbes: {
      checkDatabase: async () => {
        await pool.query("select 1");
      },
      checkRedis: async () => {
        const client = await queue.client;
        await client.info();
      },
    },
  });

  const close = async (): Promise<void> => {
    await app.close();
    await queue.close();
    await pool.end();
  };

  process.once("SIGINT", () => {
    void close().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void close().finally(() => process.exit(0));
  });

  await app.listen({ port: env.port, host: "0.0.0.0" });
}

function hasGitHubWebhookRepositories(
  repos: Pick<Repositories, "createJobFromTicket" | "appendEvent"> &
    Partial<AdminRepositories> &
    Partial<GitHubWebhookRepositories>,
): repos is Pick<Repositories, "createJobFromTicket" | "appendEvent"> & GitHubWebhookRepositories {
  return typeof repos.markPullRequestMerged === "function";
}

function installRawJsonBodyParser(app: FastifyInstance): void {
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    const rawBody = typeof body === "string" ? body : body.toString("utf8");
    (request as typeof request & { rawBody?: string }).rawBody = rawBody;
    try {
      done(null, rawBody ? JSON.parse(rawBody) : {});
    } catch (error) {
      done(error as Error);
    }
  });
}

function readRawBody(request: unknown): string {
  return typeof (request as { rawBody?: unknown }).rawBody === "string" ? (request as { rawBody: string }).rawBody : "";
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void startServer();
}

function hasSettingsRepositories(
  repos: Pick<Repositories, "createJobFromTicket" | "appendEvent"> & Partial<SettingsRepositories>,
): repos is Pick<Repositories, "createJobFromTicket" | "appendEvent"> & SettingsRepositories {
  return (
    typeof repos.getAppSettings === "function" &&
    typeof repos.setAppSettings === "function" &&
    typeof repos.appendAuditEvent === "function"
  );
}

function hasAdminRepositories(
  repos: Pick<Repositories, "createJobFromTicket" | "appendEvent"> & Partial<AdminRepositories>,
): repos is Pick<Repositories, "createJobFromTicket" | "appendEvent"> & AdminRepositories {
  return (
    typeof repos.listJobs === "function" &&
    typeof repos.getJob === "function" &&
    typeof repos.getJobEvents === "function" &&
    typeof repos.getJobLogs === "function" &&
    typeof repos.getJobArtifacts === "function" &&
    typeof repos.requestCancel === "function" &&
    typeof repos.getRetryPreflight === "function" &&
    typeof repos.createRetryAttempt === "function" &&
    typeof repos.getMetrics === "function" &&
    typeof repos.transitionJob === "function" &&
    typeof repos.appendEvent === "function"
  );
}
