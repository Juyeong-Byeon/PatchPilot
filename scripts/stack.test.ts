import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script, no type declarations.
import { buildStackPlan, resolveStackContext } from "./stack.mjs";

describe("stack helper", () => {
  it("targets the selected env file and derived compose project", () => {
    const context = resolveStackContext(["--env", ".env.github-a", "up"], {});

    expect(context.projectName).toBe("patchpilot-github-a");
    expect(context.composeArgs).toEqual(["compose", "--env-file", ".env.github-a", "-p", "patchpilot-github-a"]);
    expect(context.processEnv).toMatchObject({
      COMPOSE_PROJECT_NAME: "patchpilot-github-a",
      PATCHPILOT_ENV_FILE: ".env.github-a",
    });
  });

  it("builds status through the status script so probes use the selected ports", () => {
    const context = resolveStackContext(["--env", ".env.github-a", "status", "--strict"], {});

    expect(buildStackPlan(context)).toEqual([
      {
        command: "node",
        args: ["scripts/status.mjs", "--env", ".env.github-a", "--strict"],
        env: expect.objectContaining({ COMPOSE_PROJECT_NAME: "patchpilot-github-a" }),
      },
    ]);
  });

  it("tails api, worker, and admin logs by default", () => {
    const context = resolveStackContext(["--env", ".env.github-a", "logs"], {});

    expect(buildStackPlan(context)[0]).toMatchObject({
      command: "docker",
      args: [
        "compose",
        "--env-file",
        ".env.github-a",
        "-p",
        "patchpilot-github-a",
        "logs",
        "-f",
        "api",
        "worker",
        "admin",
      ],
    });
  });
});
