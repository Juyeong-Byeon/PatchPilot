// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { METRICS_UNAVAILABLE, SETTINGS_UNAVAILABLE, fetchJobs, fetchMetrics, fetchSettings } from "../src/api.js";

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("admin API client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports API connection failure when the dev server returns HTML", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "text/html" }),
      json: async () => {
        throw new SyntaxError("Unexpected token '<'");
      },
      text: async () => "<!doctype html>",
    } as Response);

    await expect(fetchJobs("access-key")).rejects.toThrow("admin_api_unavailable");
  });

  it("reports invalid access key for unauthorized API responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({ message: "Unauthorized" }),
    } as Response);

    await expect(fetchJobs("wrong-key")).rejects.toThrow("admin_access_key_invalid");
  });

  it("validates a well-typed metrics payload and returns it", async () => {
    const metrics = { totalJobs: 4, successRate: 0.75, runtimeSeconds: { p50: 10, p95: 40 } };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(metrics));

    await expect(fetchMetrics("access-key")).resolves.toEqual(metrics);
  });

  it("falls back to METRICS_UNAVAILABLE when the metrics body is malformed", async () => {
    // 200 + JSON, but successRate is a string — an unchecked cast would have leaked
    // this wrong shape into the dashboard render.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ successRate: "fast" }));

    await expect(fetchMetrics("access-key")).rejects.toThrow(METRICS_UNAVAILABLE);
  });

  it("validates a well-typed settings payload and returns it", async () => {
    const settings = {
      sections: [
        {
          key: "ops",
          fields: [{ key: "MAX_ATTEMPTS", value: 3, editable: true, kind: "int", applies: "live", source: "override" }],
        },
      ],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(settings));

    await expect(fetchSettings("access-key")).resolves.toEqual(settings);
  });

  it("falls back to SETTINGS_UNAVAILABLE when the settings body is malformed", async () => {
    // 200 + JSON, but a field has an unknown `kind` — the Settings page hides itself
    // instead of rendering an unrecognized control.
    const settings = {
      sections: [
        { key: "ops", fields: [{ key: "X", value: 1, editable: true, kind: "color", applies: "live", source: "env" }] },
      ],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(settings));

    await expect(fetchSettings("access-key")).rejects.toThrow(SETTINGS_UNAVAILABLE);
  });
});
