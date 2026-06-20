// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

describe("admin Vite config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("proxies API requests to the Docker-published API port", async () => {
    vi.stubEnv("HOST_API_PORT", "3001");
    const { default: config } = await import("../vite.config.js?host-api-port-test");
    const resolved =
      typeof config === "function"
        ? await config({ command: "serve", mode: "development", isPreview: false, isSsrBuild: false })
        : config;

    expect(resolved.server?.proxy?.["/api"]).toMatchObject({
      target: "http://localhost:3001",
      changeOrigin: true,
    });
  });
});
