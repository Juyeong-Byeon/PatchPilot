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
  // Snapshot and restore the version-related env around each case so stubbing in
  // one test never leaks into the next or the wider suite.
  const snapshot = {
    GIT_SHA: process.env.GIT_SHA,
    APP_VERSION: process.env.APP_VERSION,
    npm_package_version: process.env.npm_package_version,
  };
  function restore(key: keyof typeof snapshot): void {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  afterEach(() => {
    restore("GIT_SHA");
    restore("APP_VERSION");
    restore("npm_package_version");
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

  it("prefers the build-stamped APP_VERSION over npm_package_version", async () => {
    process.env.APP_VERSION = "1.2.3";
    process.env.npm_package_version = "0.1.0";
    const app = await buildVersionApp();
    const res = await app.inject({ method: "GET", url: "/api/version" });
    expect(readVersionBody(res).version).toBe("1.2.3");
  });

  it("falls back to npm_package_version when APP_VERSION is unset", async () => {
    delete process.env.APP_VERSION;
    process.env.npm_package_version = "0.1.0";
    const app = await buildVersionApp();
    const res = await app.inject({ method: "GET", url: "/api/version" });
    expect(readVersionBody(res).version).toBe("0.1.0");
  });

  it("falls back to 0.0.0 when no version env is set", async () => {
    delete process.env.APP_VERSION;
    delete process.env.npm_package_version;
    const app = await buildVersionApp();
    const res = await app.inject({ method: "GET", url: "/api/version" });
    expect(readVersionBody(res).version).toBe("0.0.0");
  });
});
