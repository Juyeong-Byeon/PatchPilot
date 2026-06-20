import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface ComposeFile {
  services?: Record<string, { volumes?: string[] }>;
}

describe("docker-compose worker service", () => {
  it("mounts the Docker socket required by gstack executor runs", async () => {
    const compose = parse(await readFile(new URL("../../../docker-compose.yml", import.meta.url), "utf8")) as ComposeFile;

    expect(compose.services?.worker?.volumes ?? []).toContain("/var/run/docker.sock:/var/run/docker.sock");
  });
});
