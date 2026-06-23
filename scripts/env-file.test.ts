import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script, no type declarations.
import {
  composeBaseArgs,
  composeProcessEnv,
  consumeEnvFileArgs,
  deriveComposeProjectName,
  displayEnvFile,
  resolveEnvFilePath,
} from "./env-file.mjs";

describe("env-file helpers", () => {
  it("consumes --env without passing it to the wrapped command", () => {
    expect(consumeEnvFileArgs(["--env", ".env.github-a", "status", "--strict"])).toEqual({
      envFile: ".env.github-a",
      rest: ["status", "--strict"],
    });
  });

  it("resolves relative env files from the repository root", () => {
    expect(displayEnvFile(resolveEnvFilePath(".env.github-a"))).toBe(".env.github-a");
  });

  it("derives a stable compose project for non-default env files", () => {
    const envPath = resolveEnvFilePath(".env.github-a");

    expect(deriveComposeProjectName(envPath, {})).toBe("patchpilot-github-a");
    expect(composeBaseArgs(envPath, {})).toEqual([
      "compose",
      "--env-file",
      ".env.github-a",
      "-p",
      "patchpilot-github-a",
    ]);
  });

  it("respects explicit COMPOSE_PROJECT_NAME", () => {
    const envPath = resolveEnvFilePath(".env.github-a");

    expect(deriveComposeProjectName(envPath, { COMPOSE_PROJECT_NAME: "custom-project" })).toBe("custom-project");
    expect(composeProcessEnv(envPath, { COMPOSE_PROJECT_NAME: "custom-project" }, {})).toMatchObject({
      COMPOSE_PROJECT_NAME: "custom-project",
      PATCHPILOT_ENV_FILE: ".env.github-a",
    });
  });
});
