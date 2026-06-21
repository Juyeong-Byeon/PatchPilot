import { maskSecrets } from "@ticket-to-pr/core";
import type { PolicyGateArtifact, VerificationVerdict } from "./policy-gate.js";

/**
 * Platform-owned trust evidence for the PR footer. Every field here is derived by
 * the platform from the database (ids, DoD, target branch) or the trusted git
 * evidence the worker already collected (`base..head` SHA, changed files) and the
 * policy gate verdict — NEVER from agent-reported values. This is the N1
 * "Platform 신뢰 footer" contract: the footer proves what was audited, independent
 * of anything the agent wrote in the body.
 */
export interface TrustFooterEvidence {
  larkRecordId: string;
  jobId: string;
  runId: string;
  repository: string;
  targetBranch: string;
  workBranch: string;
  baseSha: string;
  headSha: string;
  definitionOfDone: string;
  policy: PolicyGateArtifact;
  tests: Array<{ command: string; status: VerificationVerdict; summary?: string }>;
}

const FOOTER_SEPARATOR = "\n\n---\n\n";
const FOOTER_HEADING = "## 🛡 PatchPilot 신뢰 증거 (platform-verified)";

const VERIFICATION_LABEL: Record<VerificationVerdict, string> = {
  passed: "✅ 통과 (passed)",
  skipped: "⚠️ 검증 없음 (verification skipped)",
  failed: "❌ 실패 (failed)",
};

/**
 * Append the trusted platform footer below the agent-authored body, separated by a
 * clear `---`. The agent body stays on top untouched; the footer is composed only
 * from {@link TrustFooterEvidence}. Secrets are masked in every interpolated string
 * so a leaked token in a commit message / file path can never reach the PR body.
 */
export function composePrBodyWithFooter(agentBody: string, evidence: TrustFooterEvidence): string {
  const top = agentBody.trim();
  const footer = renderTrustFooter(evidence);
  return top.length > 0 ? `${top}${FOOTER_SEPARATOR}${footer}` : footer;
}

export function renderTrustFooter(evidence: TrustFooterEvidence): string {
  const lines: string[] = [FOOTER_HEADING, ""];

  lines.push("> 이 섹션은 플랫폼이 신뢰 가능한 git/DB 증거로 직접 생성했습니다 (에이전트 주장 아님).");
  lines.push("");

  lines.push("### 식별자");
  lines.push(`- Lark 레코드: \`${mask(evidence.larkRecordId)}\``);
  lines.push(`- Job: \`${mask(evidence.jobId)}\` · Run: \`${mask(evidence.runId)}\``);
  lines.push(
    `- 대상: \`${mask(evidence.targetBranch)}\` ← \`${mask(evidence.workBranch)}\` (${mask(evidence.repository)})`,
  );
  lines.push("");

  lines.push("### 감사된 변경 (base..head)");
  lines.push(`- \`${mask(evidence.baseSha)}..${mask(evidence.headSha)}\``);
  lines.push(renderChangedFiles(evidence.policy.changedFiles));
  lines.push("");

  lines.push("### 정책 게이트");
  lines.push(renderPolicyChecks(evidence.policy));
  lines.push("");

  lines.push("### 검증 (tests)");
  for (const line of renderTests(evidence.tests, evidence.policy.verification)) {
    lines.push(line);
  }
  lines.push("");

  lines.push("### 완료 조건 (DoD)");
  for (const line of renderDefinitionOfDone(evidence.definitionOfDone)) {
    lines.push(line);
  }

  return lines.join("\n");
}

function renderChangedFiles(changedFiles: string[]): string {
  if (changedFiles.length === 0) return "- 변경 파일: (없음)";
  const shown = changedFiles.slice(0, 20).map((file) => `\`${mask(file)}\``);
  const suffix = changedFiles.length > 20 ? ` 외 ${changedFiles.length - 20}개` : "";
  return `- 변경 파일 (${changedFiles.length}): ${shown.join(", ")}${suffix}`;
}

function renderPolicyChecks(policy: PolicyGateArtifact): string {
  const verdict = policy.status === "passed" ? "✅" : "❌";
  const checks = [
    `허용 저장소 ${policy.repositoryAllowed ? "✅" : "❌"}`,
    `보호 경로 ${policy.deniedFiles.length === 0 ? "✅" : "❌"}`,
    `검증 ${policy.verification === "failed" ? "❌" : "✅"}`,
  ];
  const lines = [`- 결과: ${verdict} ${policy.status} — ${checks.join(" · ")}`];
  if (policy.deniedFiles.length > 0) {
    lines.push(`- 차단된 보호 파일: ${policy.deniedFiles.map((file) => `\`${mask(file)}\``).join(", ")}`);
  }
  if (policy.reasons.length > 0) {
    lines.push(`- 사유: ${policy.reasons.map((reason) => mask(reason)).join("; ")}`);
  }
  return lines.join("\n");
}

function renderTests(
  tests: Array<{ command: string; status: VerificationVerdict; summary?: string }>,
  verdict: VerificationVerdict,
): string[] {
  if (tests.length === 0) {
    return [`- ${VERIFICATION_LABEL.skipped} — 실행된 검증 명령이 없습니다.`];
  }
  const lines = [`- 종합: ${VERIFICATION_LABEL[verdict]}`];
  for (const test of tests) {
    const summary = test.summary ? ` — ${mask(test.summary)}` : "";
    lines.push(`  - \`${mask(test.command)}\`: ${VERIFICATION_LABEL[test.status]}${summary}`);
  }
  return lines;
}

function renderDefinitionOfDone(definitionOfDone: string): string[] {
  const items = parseDefinitionOfDone(definitionOfDone);
  if (items.length === 0) return ["- (티켓에 완료 조건이 명시되지 않았습니다.)"];
  // Render as an unchecked checklist — the platform does not assert DoD satisfaction
  // (that is the reviewer's call); it only surfaces the ticket's stated criteria.
  return items.map((item) => `- [ ] ${mask(item)}`);
}

/**
 * Best-effort split of the ticket DoD into discrete criteria: honor explicit
 * bullets / checklist markers / numbered lists, else fall back to non-empty lines.
 */
function parseDefinitionOfDone(definitionOfDone: string): string[] {
  const lines = definitionOfDone
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const bullets = lines
    .filter((line) => /^([-*]|\d+[.)]|\[[ xX]\])\s+/.test(line) || /^- \[[ xX]\]\s+/.test(line))
    .map((line) =>
      line
        .replace(/^([-*]\s+)?(\[[ xX]\]\s+)?/, "")
        .replace(/^\d+[.)]\s+/, "")
        .trim(),
    )
    .filter(Boolean);
  if (bullets.length > 0) return bullets;
  return lines;
}

function mask(value: string): string {
  // Collapse newlines so a multi-line value cannot break the footer's markdown
  // structure, then mask any secret-looking substrings.
  return maskSecrets(value.replace(/\r?\n/g, " ").trim());
}
