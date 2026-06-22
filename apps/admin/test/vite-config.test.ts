// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

describe("admin Vite config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function resolveAdminViteConfig(config: unknown) {
    return typeof config === "function"
      ? await config({ command: "serve", mode: "development", isPreview: false, isSsrBuild: false })
      : config;
  }

  it("proxies API and webhook requests to the Docker-published API port", async () => {
    vi.stubEnv("HOST_API_PORT", "3001");
    const { default: config } = await import("../vite.config.js?host-api-port-test");
    const resolved = await resolveAdminViteConfig(config);

    expect(resolved.server?.proxy?.["/api"]).toMatchObject({
      target: "http://localhost:3001",
      changeOrigin: true,
    });
    expect(resolved.server?.proxy?.["/webhooks"]).toMatchObject({
      target: "http://localhost:3001",
      changeOrigin: true,
    });
    expect(resolved.define?.__PATCHPILOT_ADMIN_API_DISPLAY_URL__).toBe(JSON.stringify("http://localhost:3001"));
    expect(resolved.define?.__PATCHPILOT_ADMIN_API_REQUEST_MODE__).toBe(JSON.stringify("proxy"));
  });

  it("uses the server-side admin API proxy target without forcing browser-direct fetches", async () => {
    vi.stubEnv("ADMIN_API_PROXY_TARGET", "http://host.docker.internal:3002");
    const { default: config } = await import("../vite.config.js?admin-api-proxy-target-test");
    const resolved = await resolveAdminViteConfig(config);

    expect(resolved.server?.proxy?.["/api"]).toMatchObject({
      target: "http://host.docker.internal:3002",
      changeOrigin: true,
    });
    expect(resolved.define?.__PATCHPILOT_ADMIN_API_DISPLAY_URL__).toBe(
      JSON.stringify("http://host.docker.internal:3002"),
    );
    expect(resolved.define?.__PATCHPILOT_ADMIN_API_REQUEST_MODE__).toBe(JSON.stringify("proxy"));
  });

  it("still supports explicit browser-direct API overrides", async () => {
    vi.stubEnv("VITE_ADMIN_API_BASE_URL", "https://api.example.test");
    const { default: config } = await import("../vite.config.js?browser-direct-api-test");
    const resolved = await resolveAdminViteConfig(config);

    expect(resolved.server?.proxy?.["/api"]).toMatchObject({
      target: "https://api.example.test",
      changeOrigin: true,
    });
    expect(resolved.define?.__PATCHPILOT_ADMIN_API_DISPLAY_URL__).toBe(JSON.stringify("https://api.example.test"));
    expect(resolved.define?.__PATCHPILOT_ADMIN_API_REQUEST_MODE__).toBe(JSON.stringify("direct"));
  });

  it("allows configured tunnel hostnames for local dev sharing", async () => {
    vi.stubEnv(
      "ADMIN_ALLOWED_HOSTS",
      "dev-machine.tailnet.example.ts.net, .trycloudflare.com,patchpilot-dev.trycloudflare.com",
    );
    const { default: config } = await import("../vite.config.js?allowed-hosts-test");
    const resolved = await resolveAdminViteConfig(config);

    expect(resolved.server?.allowedHosts).toEqual([
      "dev-machine.tailnet.example.ts.net",
      ".trycloudflare.com",
      "patchpilot-dev.trycloudflare.com",
    ]);
  });
});
