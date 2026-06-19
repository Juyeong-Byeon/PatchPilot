import { describe, expect, it } from "vitest";
import { isProtectedPath, isRepositoryAllowed } from "../src/policy.js";

describe("policy helpers", () => {
  it("accepts allowlisted repositories only", () => {
    expect(isRepositoryAllowed("acme/web", ["acme/web"])).toBe(true);
    expect(isRepositoryAllowed("evil/web", ["acme/web"])).toBe(false);
  });

  it("matches protected path denylist entries", () => {
    expect(isProtectedPath("infra/main.tf", ["infra/**"])).toBe(true);
    expect(isProtectedPath(".env.local", [".env.*"])).toBe(true);
    expect(isProtectedPath("src/app.ts", ["infra/**", ".env.*"])).toBe(false);
  });
});
