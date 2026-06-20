// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJobs } from "../src/api.js";

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
});
