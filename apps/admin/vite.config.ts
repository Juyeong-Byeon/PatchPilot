import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, rootDir, "");
  const apiBaseUrl = env.VITE_ADMIN_API_BASE_URL || process.env.VITE_ADMIN_API_BASE_URL;
  const apiPort = process.env.HOST_API_PORT || env.HOST_API_PORT || "3000";
  const proxyTarget = apiBaseUrl || `http://localhost:${apiPort}`;

  return {
    envDir: rootDir,
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        "/api": {
          target: proxyTarget,
          changeOrigin: true
        }
      }
    }
  };
});
