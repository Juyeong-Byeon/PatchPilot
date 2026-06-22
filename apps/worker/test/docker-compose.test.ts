import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface ComposeFile {
  services?: Record<
    string,
    {
      build?: { dockerfile?: string };
      command?: string[];
      environment?: Record<string, string>;
      ports?: string[];
      volumes?: string[];
    }
  >;
}

describe("docker-compose worker service", () => {
  it("mounts the Docker socket required by gstack executor runs", async () => {
    const compose = parse(
      await readFile(new URL("../../../docker-compose.yml", import.meta.url), "utf8"),
    ) as ComposeFile;

    expect(compose.services?.worker?.volumes ?? []).toContain("/var/run/docker.sock:/var/run/docker.sock");
  });

  it("passes Codex seed paths through to worker so runner containers can use Codex login", async () => {
    const compose = parse(
      await readFile(new URL("../../../docker-compose.yml", import.meta.url), "utf8"),
    ) as ComposeFile;
    const environment = compose.services?.worker?.environment ?? {};

    expect(environment).toMatchObject({
      CODEX_AUTH_FILE: "${CODEX_AUTH_FILE:-}",
      CODEX_CONFIG_FILE: "${CODEX_CONFIG_FILE:-}",
      CODEX_SKILLS_DIR: "${CODEX_SKILLS_DIR:-}",
      GSTACK_SKILL_SOURCE_DIR: "${GSTACK_SKILL_SOURCE_DIR:-}",
      GSTACK_SINGLE_ARGS: "${GSTACK_SINGLE_ARGS:-}",
      GSTACK_STAGED_ARGS: "${GSTACK_STAGED_ARGS:-}",
    });
  });

  it("runs the admin frontend as a Docker-managed Vite service", async () => {
    const compose = parse(
      await readFile(new URL("../../../docker-compose.yml", import.meta.url), "utf8"),
    ) as ComposeFile;
    const admin = compose.services?.admin;

    expect(admin?.build?.dockerfile).toBe("docker/admin.Dockerfile");
    expect(admin?.ports ?? []).toContain("${HOST_ADMIN_PORT:-5173}:5173");
    expect(admin?.volumes ?? []).toEqual(
      expect.arrayContaining([
        "./package.json:/app/package.json:ro",
        "./package-lock.json:/app/package-lock.json:ro",
        "./tsconfig.base.json:/app/tsconfig.base.json:ro",
        "./apps/admin:/app/apps/admin",
        "admin-node-modules:/app/node_modules",
      ]),
    );
    expect(admin?.environment).toMatchObject({
      ADMIN_API_PROXY_TARGET: "${ADMIN_API_PROXY_TARGET:-http://api:3000}",
      VITE_ADMIN_API_BASE_URL: "${VITE_ADMIN_API_BASE_URL:-}",
    });
    expect(admin?.command).toEqual([
      "npm",
      "--workspace",
      "@ticket-to-pr/admin",
      "run",
      "dev",
      "--",
      "--host",
      "0.0.0.0",
    ]);
  });
});
