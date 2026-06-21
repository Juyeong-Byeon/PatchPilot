import { describe, expect, it } from "vitest";
import type { PolicyGateArtifact } from "../src/policy-gate.js";
import { composePrBodyWithFooter, renderTrustFooter, type TrustFooterEvidence } from "../src/pr-footer.js";

const passedPolicy: PolicyGateArtifact = {
  status: "passed",
  repository: "acme/web",
  repositoryAllowed: true,
  changedFiles: ["src/login.ts", "src/logout.ts"],
  deniedFiles: [],
  reasons: [],
  verification: "passed",
};

const baseEvidence: TrustFooterEvidence = {
  larkRecordId: "rec_1",
  jobId: "job_1",
  runId: "run_1",
  repository: "acme/web",
  targetBranch: "main",
  workBranch: "ticket-to-pr/job_1",
  baseSha: "0123456789abcdef0123456789abcdef01234567",
  headSha: "fedcba9876543210fedcba9876543210fedcba98",
  definitionOfDone: "- Users can log in\n- Session persists",
  policy: passedPolicy,
  tests: [{ command: "npm test", status: "passed", summary: "42 passed" }],
};

describe("composePrBodyWithFooter", () => {
  it("keeps the agent body on top and appends the footer below a separator", () => {
    const body = composePrBodyWithFooter("## Summary\nAgent prose", baseEvidence);
    expect(body.startsWith("## Summary\nAgent prose")).toBe(true);
    expect(body).toContain("\n\n---\n\n");
    expect(body.indexOf("Agent prose")).toBeLessThan(body.indexOf("신뢰 증거"));
  });

  it("renders a rich footer even when the agent body is empty", () => {
    const body = composePrBodyWithFooter("   ", baseEvidence);
    expect(body).toContain("PatchPilot 신뢰 증거");
    expect(body).toContain("`job_1`");
  });

  it("includes SHA, policy, tests, and DoD; never a fabricated git diff --name-only", () => {
    const footer = renderTrustFooter(baseEvidence);
    // base..head SHA evidence.
    expect(footer).toContain("`0123456789abcdef0123456789abcdef01234567..fedcba9876543210fedcba9876543210fedcba98`");
    // Policy verdict + which checks passed.
    expect(footer).toContain("정책 게이트");
    expect(footer).toContain("허용 저장소 ✅");
    expect(footer).toContain("보호 경로 ✅");
    // Tests (command + status).
    expect(footer).toContain("`npm test`");
    expect(footer).toContain("통과 (passed)");
    // DoD checklist.
    expect(footer).toContain("- [ ] Users can log in");
    expect(footer).toContain("- [ ] Session persists");
    // The legacy fabricated verification line must never appear.
    expect(footer).not.toContain("git diff --name-only");
  });

  it("surfaces 검증 없음 for skipped verification and never claims a pass", () => {
    const footer = renderTrustFooter({
      ...baseEvidence,
      policy: { ...passedPolicy, verification: "skipped" },
      tests: [{ command: "project verification", status: "skipped", summary: "single-pass" }],
    });
    expect(footer).toContain("검증 없음");
    expect(footer).not.toContain("통과 (passed)");
  });

  it("lists deniedFiles and reasons when the policy gate failed", () => {
    const footer = renderTrustFooter({
      ...baseEvidence,
      policy: {
        ...passedPolicy,
        status: "failed",
        deniedFiles: ["infra/prod.tf"],
        reasons: ["Protected files changed: infra/prod.tf"],
        verification: "passed",
      },
    });
    expect(footer).toContain("❌ failed");
    expect(footer).toContain("`infra/prod.tf`");
    expect(footer).toContain("Protected files changed");
  });

  it("masks secrets that appear in commit-derived strings", () => {
    const footer = renderTrustFooter({
      ...baseEvidence,
      tests: [
        {
          command: "deploy",
          status: "passed",
          summary: "used token ghp_0123456789abcdefghijklmnopqrstuvwxyz", // secret-scan:allow (fake fixture token)
        },
      ],
    });
    expect(footer).not.toContain("ghp_0123456789abcdefghijklmnopqrstuvwxyz"); // secret-scan:allow (fake fixture token)
  });
});
