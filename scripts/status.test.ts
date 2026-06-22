import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script, no type declarations.
import { parseComposePsJsonLines, statusExitCode, summarizeWorkerService } from "./status.mjs";

describe("status script", () => {
  it("parses docker compose ps JSON lines", () => {
    expect(
      parseComposePsJsonLines(
        [
          '{"Service":"api","State":"running"}',
          '{"Service":"worker","State":"running"}',
          "",
          '{"Service":"admin","State":"exited"}',
        ].join("\n"),
      ),
    ).toEqual([
      { Service: "api", State: "running" },
      { Service: "worker", State: "running" },
      { Service: "admin", State: "exited" },
    ]);
  });

  it("marks the stack unhealthy when the worker service is missing", () => {
    const summary = summarizeWorkerService([]);

    expect(summary.ok).toBe(false);
    expect(summary.severity).toBe("error");
    expect(summary.message).toContain("worker service is not running");
  });

  it("accepts a running worker service", () => {
    expect(summarizeWorkerService([{ Service: "worker", State: "running" }])).toMatchObject({
      ok: true,
      severity: "ok",
    });
  });

  it("fails strict status when the worker is absent even if probes pass", () => {
    expect(statusExitCode({ adminOk: true, apiOk: true, staleImageOk: true, workerOk: false }, { strict: true })).toBe(
      1,
    );
    expect(statusExitCode({ adminOk: true, apiOk: true, staleImageOk: true, workerOk: false }, { strict: false })).toBe(
      0,
    );
  });
});
