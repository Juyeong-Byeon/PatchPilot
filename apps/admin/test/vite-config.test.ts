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
