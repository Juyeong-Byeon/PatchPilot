import { pathToFileURL } from "node:url";
import { createPool, Repositories } from "@ticket-to-pr/db";
import { createAgentQueue } from "@ticket-to-pr/queue";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { readApiEnv } from "./env.js";
import { handleLarkWebhook, type AgentQueue, type LarkWebhookInput } from "./lark-webhook.js";
import { registerHealthRoutes } from "./routes-health.js";

export interface ApiServerDependencies {
  repos: Pick<Repositories, "createJobFromTicket" | "appendEvent">;
  queue: AgentQueue;
}

export async function buildServer(deps: ApiServerDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await registerHealthRoutes(app);
  app.post<{ Body: LarkWebhookInput }>("/webhooks/lark", async (request, reply) => {
    const result = await handleLarkWebhook(request.body, deps.repos, deps.queue);
    const statusCode = result.action === "enqueued" ? 202 : 200;
    return reply.code(statusCode).send(result);
  });

  return app;
}

export async function startServer(): Promise<void> {
  const env = readApiEnv();
  const pool = createPool(env.databaseUrl);
  const queue = createAgentQueue(env.redisUrl);
  const app = await buildServer({ repos: new Repositories(pool), queue });

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
