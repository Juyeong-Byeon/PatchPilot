import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script, no type declarations.
import { buildVerifyPlan } from "./verify.mjs";

describe("verify script", () => {
  it("runs the local quality gates in one stable order", () => {
    expect(buildVerifyPlan().map((step: { command: string; args: string[] }) => [step.command, step.args])).toEqual([
      ["npm", ["run", "format:check"]],
      ["npm", ["run", "typecheck"]],
      ["npm", ["run", "lint"]],
      ["npm", ["run", "build"]],
      ["npm", ["test"]],
      ["npm", ["run", "scan:secrets"]],
    ]);
  });

  it("is registered as npm run verify", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts.verify).toBe("node scripts/verify.mjs");
  });
});
