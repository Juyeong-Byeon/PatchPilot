import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script, no type declarations.
import { checkRunnerMounts, hasRealRepositoryAllowlist, resolvePreflightModes } from "./preflight.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("preflight mode validation", () => {
  it("accepts the default mock modes", () => {
    expect(resolvePreflightModes({})).toMatchObject({
      executorMode: "mock",
      publisherMode: "mock",
      problems: [],
    });
  });

  it("normalizes legacy PUBLISHER_MODE=gstack to github publishing", () => {
    expect(resolvePreflightModes({ EXECUTOR_MODE: "gstack", PUBLISHER_MODE: "gstack" })).toMatchObject({
      executorMode: "gstack",
      publisherMode: "github",
      problems: [],
    });
  });

  it("rejects EXECUTOR_MODE=staged with a targeted hint", () => {
    const result = resolvePreflightModes({ EXECUTOR_MODE: "staged", PUBLISHER_MODE: "github" });

    expect(result.problems.join("\n")).toContain("Use EXECUTOR_MODE=gstack");
    expect(result.problems.join("\n")).toContain("staged is selected per ticket");
  });

  it("accepts an allowlist that still contains the example plus a real repository", () => {
    expect(hasRealRepositoryAllowlist("owner/repo,Juyeong-Byeon/test_pr_repo")).toBe(true);
    expect(hasRealRepositoryAllowlist("owner/repo")).toBe(false);
  });

  it("warns when staged runner skills are missing from CODEX_SKILLS_DIR", () => {
    const result = checkRunnerMounts(
      {
        CODEX_AUTH_FILE: "/auth.json",
        CODEX_CONFIG_FILE: "/config.toml",
        CODEX_SKILLS_DIR: "/skills",
        GSTACK_SKILL_SOURCE_DIR: "/gstack",
        GSTACK_COMMAND: "node",
      },
      {
        existsSync: (path: string) => ["/auth.json", "/config.toml", "/skills", "/gstack"].includes(path),
      },
    );

    expect(result.problems).toEqual([]);
    expect(result.warnings.join("\n")).toContain("gstack-autoplan");
    expect(result.warnings.join("\n")).toContain("npm run setup");
  });

  it("warns when CODEX_SKILLS_DIR is missing in real runner mode", () => {
    const result = checkRunnerMounts(
      {
        CODEX_AUTH_FILE: "/auth.json",
        CODEX_CONFIG_FILE: "/config.toml",
        GSTACK_SKILL_SOURCE_DIR: "/gstack",
        GSTACK_COMMAND: "node",
      },
      {
        existsSync: (path: string) => ["/auth.json", "/config.toml", "/gstack"].includes(path),
      },
    );

    expect(result.problems).toEqual([]);
    expect(result.warnings.join("\n")).toContain("CODEX_SKILLS_DIR");
    expect(result.warnings.join("\n")).toContain("npm run setup");
  });

  it("warns when CODEX_SKILLS_DIR is relative", () => {
    const result = checkRunnerMounts(
      {
        CODEX_AUTH_FILE: "/auth.json",
        CODEX_CONFIG_FILE: "/config.toml",
        CODEX_SKILLS_DIR: "relative/skills",
        GSTACK_SKILL_SOURCE_DIR: "/gstack",
        GSTACK_COMMAND: "node",
      },
      {
        existsSync: (path: string) => ["/auth.json", "/config.toml", "/gstack"].includes(path),
      },
    );

    expect(result.problems).toEqual([]);
    expect(result.warnings.join("\n")).toContain("CODEX_SKILLS_DIR");
    expect(result.warnings.join("\n")).toContain("relative");
  });

  it("warns when CODEX_SKILLS_DIR does not exist", () => {
    const result = checkRunnerMounts(
      {
        CODEX_AUTH_FILE: "/auth.json",
        CODEX_CONFIG_FILE: "/config.toml",
        CODEX_SKILLS_DIR: "/missing/skills",
        GSTACK_SKILL_SOURCE_DIR: "/gstack",
        GSTACK_COMMAND: "node",
      },
      {
        existsSync: (path: string) => ["/auth.json", "/config.toml", "/gstack"].includes(path),
      },
    );

    expect(result.problems).toEqual([]);
    expect(result.warnings.join("\n")).toContain("CODEX_SKILLS_DIR");
    expect(result.warnings.join("\n")).toContain("does not exist");
  });

  it("warns when CODEX_SKILLS_DIR exists but is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "patchpilot-preflight-"));
    tempDirs.push(dir);
    const seedFile = join(dir, "seed.txt");
    const skillsDir = join(dir, "skills");
    writeFileSync(seedFile, "seed\n");
    mkdirSync(skillsDir);

    const result = checkRunnerMounts({
      CODEX_AUTH_FILE: seedFile,
      CODEX_CONFIG_FILE: seedFile,
      CODEX_SKILLS_DIR: skillsDir,
      GSTACK_SKILL_SOURCE_DIR: dir,
      GSTACK_COMMAND: "node",
    });

    expect(result.problems).toEqual([]);
    expect(result.warnings.join("\n")).toContain("is empty");
    expect(result.warnings.join("\n")).toContain("patchpilot-ticket-runner");
  });
});
