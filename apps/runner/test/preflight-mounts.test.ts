import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// The doctor/preflight script lives in scripts/ (plain .mjs). It is plumbed into the same
// vitest run via this thin TS wrapper so the real-mode mount validation (L7) is gated in CI.
import { checkRunnerMounts, preflightExitCode } from "../../../scripts/preflight.mjs";

const PRESENT = fileURLToPath(import.meta.url); // a path that definitely exists

describe("checkRunnerMounts (L7 doctor real-mode preflight)", () => {
  const fullEnv = {
    CODEX_AUTH_FILE: PRESENT,
    CODEX_CONFIG_FILE: PRESENT,
    CODEX_SKILLS_DIR: PRESENT,
    GSTACK_SKILL_SOURCE_DIR: PRESENT,
    GSTACK_COMMAND: "node",
  };

  it("passes clean when every mount resolves", () => {
    const { problems, warnings } = checkRunnerMounts(fullEnv);
    expect(problems).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("fails with the precise var when a mount is missing entirely", () => {
    const { problems } = checkRunnerMounts({ ...fullEnv, CODEX_AUTH_FILE: undefined });
    expect(problems.some((m) => m.includes("CODEX_AUTH_FILE"))).toBe(true);
  });

  it("fails when a mount path does not exist on the host", () => {
    const { problems } = checkRunnerMounts({ ...fullEnv, GSTACK_SKILL_SOURCE_DIR: "/no/such/gstack" });
    expect(problems.some((m) => m.includes("GSTACK_SKILL_SOURCE_DIR") && m.includes("does not exist"))).toBe(true);
  });

  it("warns (not fails) when a value still uses $HOME, which .env does not expand", () => {
    const { problems, warnings } = checkRunnerMounts({ ...fullEnv, CODEX_CONFIG_FILE: "$HOME/.codex/config.toml" });
    expect(problems).toEqual([]);
    expect(warnings.some((m) => m.includes("CODEX_CONFIG_FILE") && m.includes("$HOME"))).toBe(true);
  });

  it("warns on a leading ~ as well", () => {
    const { warnings } = checkRunnerMounts({ ...fullEnv, CODEX_SKILLS_DIR: "~/.codex/skills" });
    expect(warnings.some((m) => m.includes("CODEX_SKILLS_DIR"))).toBe(true);
  });

  it("warns when GSTACK_COMMAND is empty", () => {
    const { warnings } = checkRunnerMounts({ ...fullEnv, GSTACK_COMMAND: undefined });
    expect(warnings.some((m) => m.includes("GSTACK_COMMAND"))).toBe(true);
  });

  it("can promote warnings to failures for strict real-mode checks", () => {
    const result = { info: [], problems: [], warnings: ["CODEX_CONFIG_FILE uses $HOME"] };

    expect(preflightExitCode(result, { strictWarnings: true })).toBe(1);
    expect(preflightExitCode(result, { strictWarnings: false })).toBe(0);
  });

  it("registers strict doctor as an npm script", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));

    expect(pkg.scripts["doctor:strict"]).toBe("node scripts/preflight.mjs --strict");
  });
});
