import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain .mjs script, no type declarations.
import {
  bundledCodexSkills,
  hostDatabaseUrl,
  installBundledCodexSkills,
  planFreshEnvPortUpdates,
  setEnvValue,
} from "./setup.mjs";

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

  it("installs bundled Codex skills into CODEX_SKILLS_DIR", () => {
    const dir = mkdtempSync(join(tmpdir(), "patchpilot-skills-"));
    const result = installBundledCodexSkills({ CODEX_SKILLS_DIR: dir });

    expect(result.installed).toEqual(bundledCodexSkills);
    for (const skill of bundledCodexSkills) {
      const skillPath = join(dir, skill, "SKILL.md");
      expect(existsSync(skillPath)).toBe(true);
      expect(readFileSync(skillPath, "utf8")).toContain(`name: ${skill}`);
    }
    expect(existsSync(join(dir, "patchpilot-ticket-runner", "agents", "openai.yaml"))).toBe(true);
    expect(existsSync(join(dir, "patchpilot-ticket-runner", "references", "contracts.md"))).toBe(true);
    expect(existsSync(join(dir, "patchpilot-ticket-runner", "references", "staged-workflow.md"))).toBe(true);
    expect(existsSync(join(dir, "patchpilot-ticket-runner", "references", "pr-description.md"))).toBe(true);
  });

  it("does not install bundled Codex skills into a relative CODEX_SKILLS_DIR", () => {
    const result = installBundledCodexSkills({ CODEX_SKILLS_DIR: "relative/skills" });

    expect(result.installed).toEqual([]);
    expect(result.skipped).toEqual(bundledCodexSkills);
    expect(result.reason).toContain("absolute path");
  });
});
