import { describe, expect, it } from "vitest";
import { formatStageBanner, GSTACK_STAGE_KEYS, parseStageBanner } from "../src/gstack-stages.js";

describe("gstack stage banner contract", () => {
  it("round-trips every known stage through format -> parse", () => {
    GSTACK_STAGE_KEYS.forEach((key, position) => {
      const index = position + 1;
      const line = formatStageBanner(index, GSTACK_STAGE_KEYS.length, key);
      expect(parseStageBanner(line)).toEqual({ index, total: GSTACK_STAGE_KEYS.length, key });
    });
  });

  it("formats the exact banner the runner prints", () => {
    expect(formatStageBanner(3, 4, "review")).toBe("=== gstack stage 3/4: review ===");
  });

  it("parses a banner that is part of a larger log line", () => {
    expect(parseStageBanner("noise === gstack stage 2/4: implement === trailing")).toEqual({
      index: 2,
      total: 4,
      key: "implement",
    });
  });

  it("returns null for non-banner lines", () => {
    expect(parseStageBanner("just a normal log line")).toBeNull();
    expect(parseStageBanner("")).toBeNull();
  });
});
