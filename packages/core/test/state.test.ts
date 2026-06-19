import { describe, expect, it } from "vitest";
import { deriveOutcome, transitionPhase } from "../src/state.js";

describe("transitionPhase", () => {
  it("allows queued to planning", () => {
    expect(transitionPhase("Queued", "Planning")).toBe("Planning");
  });

  it("blocks publishing before policy checking", () => {
    expect(() => transitionPhase("Testing", "Publishing")).toThrow(/Invalid phase transition/);
  });
});

describe("deriveOutcome", () => {
  it("maps active phase to Running", () => {
    expect(deriveOutcome("Testing")).toBe("Running");
  });

  it("maps completed phase to NeedsReview", () => {
    expect(deriveOutcome("Completed")).toBe("NeedsReview");
  });
});
