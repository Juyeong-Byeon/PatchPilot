import Fastify from "fastify";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerVersionRoutes, type VersionInfo } from "../src/routes-version.js";

const apps: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function buildVersionApp() {
  const app = Fastify();
  await registerVersionRoutes(app);
  apps.push(app);
  return app;
}

// Narrow the inject response body to the documented contract at the test
// boundary so each assertion reads against typed fields, not `unknown`.
function readVersionBody(res: LightMyRequestResponse): VersionInfo {
  const body: unknown = res.json();
  if (typeof body !== "object" || body === null) throw new Error("version body is not an object");
  const { version, sha } = body as Record<string, unknown>;
  if (typeof version !== "string") throw new Error("version is not a string");
  if (sha !== null && typeof sha !== "string") throw new Error("sha is neither string nor null");
  return { version, sha };
}

describe("version routes", () => {
  // Snapshot and restore GIT_SHA around each case so stubbing one test never
  // leaks into the next or the wider suite.
  const originalGitSha = process.env.GIT_SHA;
  afterEach(() => {
    if (originalGitSha === undefined) {
      delete process.env.GIT_SHA;
    } else {
      process.env.GIT_SHA = originalGitSha;
    }
  });

  it("returns 200 JSON with a string version and string-or-null sha", async () => {
    const app = await buildVersionApp();
    const res = await app.inject({ method: "GET", url: "/api/version" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    const body = readVersionBody(res);
    expect(typeof body.version).toBe("string");
    expect(body.sha === null || typeof body.sha === "string").toBe(true);
  });

  it("surfaces GIT_SHA when the process is given one", async () => {
    process.env.GIT_SHA = "abc1234";
    const app = await buildVersionApp();
    const res = await app.inject({ method: "GET", url: "/api/version" });
    expect(res.statusCode).toBe(200);
    expect(readVersionBody(res).sha).toBe("abc1234");
  });

  it("reports sha null when GIT_SHA is unset", async () => {
    delete process.env.GIT_SHA;
    const app = await buildVersionApp();
    const res = await app.inject({ method: "GET", url: "/api/version" });
    expect(res.statusCode).toBe(200);
    expect(readVersionBody(res).sha).toBeNull();
  });
});
