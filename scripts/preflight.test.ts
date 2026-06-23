import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script, no type declarations.
import { checkRunnerMounts, hasRealRepositoryAllowlist, resolvePreflightModes } from "./preflight.mjs";

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
});
