import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    environmentOptions: {
      jsdom: {
        url: "http://localhost:5173",
      },
    },
    setupFiles: ["../../vitest.setup.ts"],
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  },
});
