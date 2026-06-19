import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@ticket-to-pr/runner-contract": fileURLToPath(new URL("../../packages/runner-contract/src/index.ts", import.meta.url))
    }
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node"
  }
});
