import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function parseAllowedHosts(value: string | undefined) {
  return value
    ?.split(",")
    .map((host) => host.trim())
    .filter(Boolean);
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, rootDir, "");
  const apiBaseUrl = env.VITE_ADMIN_API_BASE_URL || process.env.VITE_ADMIN_API_BASE_URL;
  const apiPort = process.env.HOST_API_PORT || env.HOST_API_PORT || "3000";
  const proxyTarget = apiBaseUrl || `http://localhost:${apiPort}`;
  const allowedHosts = parseAllowedHosts(
    process.env.ADMIN_ALLOWED_HOSTS ||
      env.ADMIN_ALLOWED_HOSTS ||
      process.env.VITE_ADMIN_ALLOWED_HOSTS ||
      env.VITE_ADMIN_ALLOWED_HOSTS,
  );

  return {
    envDir: rootDir,
    plugins: [react(), tailwindcss()],
    server: {
      ...(allowedHosts?.length ? { allowedHosts } : {}),
      proxy: {
        "/api": {
          target: proxyTarget,
          changeOrigin: true,
        },
        "/webhooks": {
          target: proxyTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
