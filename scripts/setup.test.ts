import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script, no type declarations.
import { hostDatabaseUrl, planFreshEnvPortUpdates, setEnvValue } from "./setup.mjs";

describe("setup script helpers", () => {
  it("rewrites the Compose database hostname for host-run migrations", () => {
    expect(hostDatabaseUrl({ DATABASE_URL: "postgres://u:p@postgres:5432/app" })).toBe(
      "postgres://u:p@localhost:5432/app",
    );
  });

  it("updates an existing env key without disturbing the rest of the file", () => {
    expect(setEnvValue("A=1\nHOST_API_PORT=3000\nB=2\n", "HOST_API_PORT", "3001")).toBe(
      "A=1\nHOST_API_PORT=3001\nB=2\n",
    );
  });

  it("appends a missing env key with a trailing newline", () => {
    expect(setEnvValue("A=1\n", "HOST_ADMIN_PORT", "5174")).toBe("A=1\nHOST_ADMIN_PORT=5174\n");
  });

  it("auto-selects fresh checkout ports when defaults are busy", async () => {
    const busy = new Set([3000, 5173]);
    const updates = await planFreshEnvPortUpdates(
      {
        PUBLIC_BASE_URL: "http://localhost:3000",
        HOST_API_PORT: "3000",
        HOST_ADMIN_PORT: "5173",
      },
      async (port: number) => !busy.has(port),
    );

    expect(updates).toEqual({
      PUBLIC_BASE_URL: "http://localhost:3001",
      HOST_API_PORT: "3001",
      HOST_ADMIN_PORT: "5174",
    });
  });
});
