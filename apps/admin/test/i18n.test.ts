import { describe, expect, it } from "vitest";
import { translateFailureCategory, translateState } from "../src/i18n.js";

describe("translateState", () => {
  it("translates every job state in English instead of leaking raw enum values", () => {
    expect(translateState("PolicyChecking", "en")).toBe("Policy Check");
    expect(translateState("FailedActionable", "en")).toBe("Action Needed");
    expect(translateState("FailedInternal", "en")).toBe("Internal Failure");
    expect(translateState("NeedsReview", "en")).toBe("Needs Review");
  });

  it("translates Korean states", () => {
    expect(translateState("PolicyChecking", "ko")).toBe("정책 검사");
    expect(translateState("NeedsReview", "ko")).toBe("PR 리뷰 대기중");
  });

  it("falls back to a humanized CamelCase split for unmapped codes", () => {
    expect(translateState("SomeFutureState", "en")).toBe("Some Future State");
  });

  it("returns the empty marker for blank values", () => {
    expect(translateState("", "en")).toBe("-");
    expect(translateState(null, "ko")).toBe("-");
  });
});

describe("translateFailureCategory", () => {
  it("translates known failure codes", () => {
    expect(translateFailureCategory("policy", "en")).toBe("Policy");
    expect(translateFailureCategory("infra", "ko")).toBe("인프라");
  });

  it("passes through unknown codes unchanged", () => {
    expect(translateFailureCategory("github_auth", "en")).toBe("github_auth");
  });
});
