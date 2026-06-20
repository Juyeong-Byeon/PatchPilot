import { describe, expect, it } from "vitest";
import { parseLarkTicket, shouldCreateJobFromTicket } from "../src/lark.js";

const baseFields = {
  Title: "Fix login",
  Description: "Button should route to dashboard",
  "Definition of Done": "Clicking button opens dashboard",
  Repository: "acme/web",
  "Target Branch": "main",
  Priority: "Normal",
  Status: "Progress",
  "Agent Run Requested": true,
};

describe("parseLarkTicket", () => {
  it("parses required fields", () => {
    const ticket = parseLarkTicket("rec1", "v1", baseFields);
    expect(ticket.repository).toBe("acme/web");
    expect(ticket.targetBranch).toBe("main");
  });

  it("rejects missing definition of done", () => {
    expect(() => parseLarkTicket("rec1", "v1", { ...baseFields, "Definition of Done": "" })).toThrow(
      /Definition of Done/,
    );
  });
});

describe("shouldCreateJobFromTicket", () => {
  it("requires Progress and Agent Run Requested", () => {
    expect(shouldCreateJobFromTicket(parseLarkTicket("rec1", "v1", baseFields))).toBe(true);
    expect(shouldCreateJobFromTicket(parseLarkTicket("rec1", "v1", { ...baseFields, Status: "Todo" }))).toBe(false);
  });
});
