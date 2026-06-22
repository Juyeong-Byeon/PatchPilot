import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script, no type declarations.
import { formatDivergenceSummary } from "./update.mjs";

describe("update script", () => {
  it("reports ahead-only checkouts explicitly", () => {
    const summary = formatDivergenceSummary({ aheadCount: 2, behindCount: 0 });

    expect(summary).toContain("Ahead by       : 2 commits");
    expect(summary).toContain("no incoming commits");
  });

  it("reports diverged checkouts as not fast-forwardable", () => {
    const summary = formatDivergenceSummary({ aheadCount: 1, behindCount: 3 });

    expect(summary).toContain("Ahead by       : 1 commit");
    expect(summary).toContain("Behind by      : 3 commits");
    expect(summary).toContain("fast-forward update is not applicable");
  });
});
