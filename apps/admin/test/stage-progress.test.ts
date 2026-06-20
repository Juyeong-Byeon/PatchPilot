import { describe, expect, it } from "vitest";
import { isStageBannerText, parseStageProgress } from "../src/lib/status.js";

describe("parseStageProgress", () => {
  it("returns the latest stage banner from the logs", () => {
    const progress = parseStageProgress([
      { text: "starting" },
      { text: "=== gstack stage 1/4: plan ===" },
      { text: "planning..." },
      { text: "=== gstack stage 3/4: review ===" },
      { text: "reviewing..." },
    ]);
    expect(progress).toEqual({ index: 3, total: 4, key: "review" });
  });

  it("returns null when there is no stage banner", () => {
    expect(parseStageProgress([{ text: "just some logs" }, { text: null }])).toBeNull();
  });
});

describe("isStageBannerText", () => {
  it("detects gstack stage banners", () => {
    expect(isStageBannerText("=== gstack stage 2/4: implement ===")).toBe(true);
    expect(isStageBannerText("normal log line")).toBe(false);
    expect(isStageBannerText(undefined)).toBe(false);
  });
});
