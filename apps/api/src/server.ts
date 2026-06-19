import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import fastifyStatic from "@fastify/static";
import { createPool, Repositories } from "@ticket-to-pr/db";
import { createAgentQueue } from "@ticket-to-pr/queue";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { readApiEnv } from "./env.js";
import { handleLarkWebhook, type AgentQueue, type LarkWebhookInput } from "./lark-webhook.js";
import { registerAdminRoutes, type AdminRepositories } from "./routes-admin.js";
import { registerHealthRoutes } from "./routes-health.js";

export interface ApiServerDependencies {
  repos: Pick<Repositories, "createJobFromTicket" | "appendEvent"> & Partial<AdminRepositories>;
  queue: AgentQueue;
  adminToken?: string;
  adminStaticRoot?: string;
}

export async function buildServer(deps: ApiServerDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await registerHealthRoutes(app);
  if (deps.adminToken && hasAdminRepositories(deps.repos)) {
    await registerAdminRoutes(app, deps.repos, deps.queue, deps.adminToken);
  }
  app.post<{ Body: LarkWebhookInput }>("/webhooks/lark", async (request, reply) => {
    const result = await handleLarkWebhook(request.body, deps.repos, deps.queue);
    const statusCode = result.action === "enqueued" ? 202 : 200;
    return reply.code(statusCode).send(result);
  });
  if (deps.adminStaticRoot && existsSync(deps.adminStaticRoot)) {
    await app.register(fastifyStatic, {
      root: deps.adminStaticRoot,
      prefix: "/"
    });
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
    adminStaticRoot: join(process.cwd(), "apps/admin/dist")
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void startServer();
}

function hasAdminRepositories(
  repos: Pick<Repositories, "createJobFromTicket" | "appendEvent"> & Partial<AdminRepositories>
): repos is Pick<Repositories, "createJobFromTicket" | "appendEvent"> & AdminRepositories {
  return (
    typeof repos.listJobs === "function" &&
    typeof repos.getJob === "function" &&
    typeof repos.getJobEvents === "function" &&
    typeof repos.getJobLogs === "function" &&
    typeof repos.getJobArtifacts === "function" &&
    typeof repos.requestCancel === "function" &&
    typeof repos.getRetryPreflight === "function" &&
    typeof repos.createRetryAttempt === "function"
  );
}
