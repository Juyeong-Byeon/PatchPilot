import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/config.js";

describe("parseCsv", () => {
  it("trims empty entries", () => {
    expect(parseCsv("acme/web, acme/api,")).toEqual(["acme/web", "acme/api"]);
  });
});
