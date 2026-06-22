import { describe, expect, it } from "vitest";
import { resolveFastifyLoggerOption } from "../src/server.js";

describe("resolveFastifyLoggerOption", () => {
  it("disables Fastify request logging under Vitest", () => {
    expect(resolveFastifyLoggerOption({ VITEST: "true" })).toBe(false);
  });

  it("disables Fastify request logging for NODE_ENV=test", () => {
    expect(resolveFastifyLoggerOption({ NODE_ENV: "test" })).toBe(false);
  });

  it("keeps request logging on outside tests", () => {
    expect(resolveFastifyLoggerOption({ NODE_ENV: "production" })).toBe(true);
  });
});
