import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "apps/**/*.test.tsx", "scripts/**/*.test.ts"],
    environment: "node",
    passWithNoTests: true,
    // Coverage is opt-in via `npm run test:coverage` (the v8 provider) — `npm test`
    // is unaffected. Pilot per docs/library-adoption-plan.md (Tier 2); scoped to
    // workspace source so generated dist/ and configs don't dilute the numbers.
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "coverage",
      include: ["packages/*/src/**", "apps/*/src/**"],
    },
  },
});
