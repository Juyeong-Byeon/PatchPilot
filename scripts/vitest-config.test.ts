import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("root vitest config", () => {
  it("limits coverage instrumentation to TypeScript source files", () => {
    const source = readFileSync(new URL("../vitest.config.ts", import.meta.url), "utf8");

    expect(source).toContain('include: ["packages/*/src/**/*.{ts,tsx}", "apps/*/src/**/*.{ts,tsx}"]');
    expect(source).not.toContain('include: ["packages/*/src/**", "apps/*/src/**"]');
  });
});
