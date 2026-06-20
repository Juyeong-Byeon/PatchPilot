import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerHealthRoutes } from "../src/routes-health.js";

const apps: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function buildHealthApp(probes?: Parameters<typeof registerHealthRoutes>[1]) {
  const app = Fastify();
  await registerHealthRoutes(app, probes);
  apps.push(app);
  return app;
}

describe("health routes", () => {
  it("liveness is dependency-free and always ok", async () => {
    const app = await buildHealthApp();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("readiness reports ok when dependencies answer", async () => {
    const app = await buildHealthApp({
      checkDatabase: async () => undefined,
      checkRedis: async () => undefined,
    });
    const res = await app.inject({ method: "GET", url: "/api/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, checks: { database: "ok", redis: "ok" } });
  });

  it("readiness returns 503 with the failing dependency when a probe rejects", async () => {
    const app = await buildHealthApp({
      checkDatabase: async () => {
        throw new Error("connection refused");
      },
      checkRedis: async () => undefined,
    });
    const res = await app.inject({ method: "GET", url: "/api/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, checks: { database: "down", redis: "ok" } });
  });
});
