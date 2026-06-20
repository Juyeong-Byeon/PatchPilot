import type { FastifyInstance } from "fastify";

export interface HealthProbes {
  /** Resolves when Postgres answers a trivial query, rejects otherwise. */
  checkDatabase?: () => Promise<void>;
  /** Resolves when Redis answers PING, rejects otherwise. */
  checkRedis?: () => Promise<void>;
}

type DependencyStatus = "ok" | "down" | "skipped";

export async function registerHealthRoutes(app: FastifyInstance, probes: HealthProbes = {}): Promise<void> {
  // Liveness: the process is up and serving. Cheap and dependency-free so it
  // never flaps when Postgres/Redis are briefly unavailable.
  app.get("/api/health", async () => ({ ok: true }));

  // Readiness: the process can actually do work — used by the setup script and
  // compose healthcheck to wait for a genuinely usable stack, not just a bound port.
  app.get("/api/ready", async (_request, reply) => {
    const checks: Record<string, DependencyStatus> = {
      database: await runProbe(probes.checkDatabase),
      redis: await runProbe(probes.checkRedis)
    };
    const ok = Object.values(checks).every((status) => status !== "down");
    if (!ok) return reply.code(503).send({ ok: false, checks });
    return { ok: true, checks };
  });
}

async function runProbe(probe?: () => Promise<void>): Promise<DependencyStatus> {
  if (!probe) return "skipped";
  try {
    await probe();
    return "ok";
  } catch {
    return "down";
  }
}
