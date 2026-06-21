import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server.js";

function makeRepos(overrides: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...overrides };
  return {
    store,
    createJobFromTicket: vi.fn(),
    appendEvent: vi.fn(),
    getAppSettings: vi.fn(async () => ({ ...store })),
    setAppSettings: vi.fn(async (updates: Record<string, unknown>) => {
      Object.assign(store, updates);
    }),
    appendAuditEvent: vi.fn(async () => undefined),
  };
}

async function build(repos: ReturnType<typeof makeRepos>) {
  return buildServer({
    adminToken: "secret",
    larkWebhookSecret: "webhook-secret",
    repos: repos as never,
    queue: { add: vi.fn() },
  });
}

describe("settings routes", () => {
  const prevTimeout = process.env.WORKER_JOB_TIMEOUT_SECONDS;
  const prevAllowlist = process.env.REPOSITORY_ALLOWLIST;

  beforeEach(() => {
    process.env.WORKER_JOB_TIMEOUT_SECONDS = "1800";
    process.env.REPOSITORY_ALLOWLIST = "acme/web,acme/api";
  });

  afterEach(() => {
    if (prevTimeout === undefined) delete process.env.WORKER_JOB_TIMEOUT_SECONDS;
    else process.env.WORKER_JOB_TIMEOUT_SECONDS = prevTimeout;
    if (prevAllowlist === undefined) delete process.env.REPOSITORY_ALLOWLIST;
    else process.env.REPOSITORY_ALLOWLIST = prevAllowlist;
    vi.restoreAllMocks();
  });

  it("requires the admin token", async () => {
    const app = await build(makeRepos());
    const response = await app.inject({ method: "GET", url: "/api/settings" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("GET returns sections with effective values and excludes secret fields", async () => {
    const app = await build(makeRepos());
    const response = await app.inject({
      method: "GET",
      url: "/api/settings",
      headers: { authorization: "Bearer secret" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      sections: Array<{
        key: string;
        fields: Array<{ key: string; value: unknown; source: string; secret?: boolean }>;
      }>;
    };
    const allFields = body.sections.flatMap((s) => s.fields);
    // No field carries a secret flag, and the shape never includes secret values.
    expect(allFields.every((f) => !("secret" in f))).toBe(true);
    const timeout = allFields.find((f) => f.key === "jobTimeoutSeconds");
    expect(timeout?.value).toBe(1800);
    expect(timeout?.source).toBe("env");
    const allowlist = allFields.find((f) => f.key === "repositoryAllowlist");
    expect(allowlist?.value).toEqual(["acme/web", "acme/api"]);
    await app.close();
  });

  it("PUT rejects a non-editable key with 400", async () => {
    const repos = makeRepos();
    const app = await build(repos);
    const response = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { authorization: "Bearer secret" },
      payload: { updates: { repositoryAllowlist: ["evil/repo"] } },
    });
    expect(response.statusCode).toBe(400);
    expect(repos.setAppSettings).not.toHaveBeenCalled();
    await app.close();
  });

  it("PUT rejects an out-of-range editable value with 400", async () => {
    const repos = makeRepos();
    const app = await build(repos);
    const response = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { authorization: "Bearer secret" },
      payload: { updates: { jobTimeoutSeconds: 5 } },
    });
    expect(response.statusCode).toBe(400);
    expect(repos.setAppSettings).not.toHaveBeenCalled();
    await app.close();
  });

  it("PUT persists a valid editable value, audits it, and returns the new effective config", async () => {
    const repos = makeRepos();
    const app = await build(repos);
    const response = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { authorization: "Bearer secret" },
      payload: { updates: { jobTimeoutSeconds: 600, highPriorityStaged: false } },
    });
    expect(response.statusCode).toBe(200);
    expect(repos.setAppSettings).toHaveBeenCalledWith({ jobTimeoutSeconds: 600, highPriorityStaged: false }, "admin");
    expect(repos.appendAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "admin", action: "settings.updated" }),
    );
    const body = response.json() as {
      sections: Array<{ fields: Array<{ key: string; value: unknown; source: string }> }>;
    };
    const timeout = body.sections.flatMap((s) => s.fields).find((f) => f.key === "jobTimeoutSeconds");
    expect(timeout?.value).toBe(600);
    expect(timeout?.source).toBe("override");
    await app.close();
  });

  it("does not register settings routes when the repository lacks the methods (graceful 404)", async () => {
    const app = await buildServer({
      adminToken: "secret",
      larkWebhookSecret: "webhook-secret",
      repos: { createJobFromTicket: vi.fn(), appendEvent: vi.fn() } as never,
      queue: { add: vi.fn() },
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/settings",
      headers: { authorization: "Bearer secret" },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
