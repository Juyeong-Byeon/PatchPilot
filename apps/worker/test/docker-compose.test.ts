import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface ComposeFile {
  services?: Record<string, { environment?: Record<string, string>; volumes?: string[] }>;
}

describe("docker-compose worker service", () => {
  it("mounts the Docker socket required by gstack executor runs", async () => {
    const compose = parse(await readFile(new URL("../../../docker-compose.yml", import.meta.url), "utf8")) as ComposeFile;

    expect(compose.services?.worker?.volumes ?? []).toContain("/var/run/docker.sock:/var/run/docker.sock");
  });

  it("passes Codex seed paths through to worker so runner containers can use Codex login", async () => {
    const compose = parse(await readFile(new URL("../../../docker-compose.yml", import.meta.url), "utf8")) as ComposeFile;
    const environment = compose.services?.worker?.environment ?? {};

    expect(environment).toMatchObject({
      CODEX_AUTH_FILE: "${CODEX_AUTH_FILE:-}",
      CODEX_CONFIG_FILE: "${CODEX_CONFIG_FILE:-}",
      CODEX_SKILLS_DIR: "${CODEX_SKILLS_DIR:-}",
      GSTACK_SKILL_SOURCE_DIR: "${GSTACK_SKILL_SOURCE_DIR:-}"
    });
  });
});
