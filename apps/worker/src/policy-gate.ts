import { isProtectedPath, isRepositoryAllowed } from "@ticket-to-pr/core";
import type { AgentResult } from "@ticket-to-pr/core";
import { collectSecretScanTargets, scanForSecrets, type SecretFinding } from "./secret-scan.js";

export interface WorkerPolicyConfig {
  repositoryAllowlist: string[];
  protectedPathDenylist: string[];
}

export interface PolicyGateInput extends WorkerPolicyConfig {
  repository: string;
  expectedTargetBranch?: string;
}

// git-forbidden ref characters: space, the special set `~ ^ : ? * [ \`, and ASCII
// control chars (0x00-0x1f and DEL 0x7f). Built via fromCharCode so the source
// carries no raw control bytes.
const FORBIDDEN_BRANCH_CHARS = new RegExp(
  `[ ${"~^:?*[\\\\"}${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`,
);

/**
 * Validate a git branch name against the parts of git's ref-format rules that
 * matter for safety (X7 pre-exec gate). Rejects empty/over-long, surrounding
 * whitespace, leading/trailing slashes, `//`, leading/trailing dots, `..`, a
 * trailing `.lock`, git's forbidden characters, and the `@{` sequence. Catching a
 * malformed target branch BEFORE the expensive agent run avoids a guaranteed-to-fail
 * publish at the very end of a long job.
 */
export function isValidBranchName(branch: string): boolean {
  if (!branch || branch.length > 255) return false;
  if (branch.trim() !== branch) return false;
  if (branch.startsWith("/") || branch.endsWith("/") || branch.includes("//")) return false;
  if (branch.startsWith(".") || branch.endsWith(".") || branch.includes("..")) return false;
  if (branch.endsWith(".lock")) return false;
  if (FORBIDDEN_BRANCH_CHARS.test(branch)) return false;
  if (branch.includes("@{")) return false;
  return true;
}

export type VerificationVerdict = "passed" | "skipped" | "failed";

export interface PolicyGateArtifact {
  status: "passed" | "failed";
  repository: string;
  repositoryAllowed: boolean;
  changedFiles: string[];
  deniedFiles: string[];
  reasons: string[];
  /**
   * Trusted summary of the verification evidence the gate evaluated. `passed` when
   * at least one test passed and none failed; `failed` on any explicit failure;
   * `skipped` when verification was honestly not run (single-pass). Surfaced in the
   * platform PR footer and the admin evidence card — never an agent claim.
   */
  verification: VerificationVerdict;
  /**
   * Secret-scan findings over the agent's diff evidence (X7). Each entry names the
   * rule and a masked snippet; the actual secret is never stored. Empty on a clean
   * diff. Any non-empty value blocks the gate.
   */
  secretFindings?: SecretFinding[];
}

/**
 * Collapse the per-test statuses into a single trusted verdict. Any explicit
 * `failed` dominates; otherwise at least one `passed` means passed; everything
 * else (only skipped, or no tests at all) is `skipped`.
 */
export function summarizeVerification(tests: AgentResult["tests"]): VerificationVerdict {
  if (tests.some((test) => test.status === "failed")) return "failed";
  if (tests.some((test) => test.status === "passed")) return "passed";
  return "skipped";
}

export interface PolicyGateResult {
  allowed: boolean;
  reason?: string | undefined;
  artifact: PolicyGateArtifact;
}

/**
 * Cheap checks run BEFORE the expensive agent run (X7). Catches the failures we can
 * know up front — repository not allowlisted, a malformed target branch, or a
 * target branch that is itself a protected path — so a doomed job never pays for a
 * full runner launch. The changed-file denylist and secret scan still run in the
 * post-run {@link evaluatePolicyGate} (those need the diff that only exists after
 * the agent runs).
 */
export function evaluatePreExecutionPolicy(input: PolicyGateInput): PolicyGateResult {
  const repositoryAllowed = isRepositoryAllowed(input.repository, input.repositoryAllowlist);
  const reasons: string[] = [];

  if (!repositoryAllowed) {
    reasons.push(`Repository is not allowlisted: ${input.repository}`);
  }
  if (input.expectedTargetBranch !== undefined && !isValidBranchName(input.expectedTargetBranch)) {
    reasons.push(`Invalid target branch name: ${input.expectedTargetBranch}`);
  } else if (
    input.expectedTargetBranch !== undefined &&
    isProtectedPath(input.expectedTargetBranch, input.protectedPathDenylist)
  ) {
    // A target branch that matches the protected-path denylist is a misconfiguration
    // we can reject up front rather than after a full run.
    reasons.push(`Target branch is protected: ${input.expectedTargetBranch}`);
  }

  const allowed = reasons.length === 0;
  return {
    allowed,
    reason: allowed ? undefined : reasons.join("; "),
    artifact: {
      status: allowed ? "passed" : "failed",
      repository: input.repository,
      repositoryAllowed,
      changedFiles: [],
      deniedFiles: [],
      reasons,
      verification: "skipped",
    },
  };
}

export function evaluatePolicyGate(result: AgentResult, input: PolicyGateInput): PolicyGateResult {
  const changedFiles = result.changedFiles;
  const repositoryAllowed = isRepositoryAllowed(input.repository, input.repositoryAllowlist);
  const deniedFiles = changedFiles.filter((file) => isProtectedPath(file, input.protectedPathDenylist));
  const reasons: string[] = [];

  if (!repositoryAllowed) {
    reasons.push(`Repository is not allowlisted: ${input.repository}`);
  }
  if (deniedFiles.length > 0) {
    reasons.push(`Protected files changed: ${deniedFiles.join(", ")}`);
  }
  if (input.expectedTargetBranch && result.targetBranch !== input.expectedTargetBranch) {
    reasons.push(
      `Target branch mismatch: expected ${input.expectedTargetBranch}, got ${result.targetBranch ?? "unknown"}`,
    );
  }
  if (result.commits.length === 0) {
    reasons.push("No local commit evidence was produced");
  }
  if (!result.pullRequestDraft?.title || !result.pullRequestDraft.bodyPath) {
    reasons.push("PR draft is missing");
  }
  // Verification is BLOCKING only on an explicit failure. A `skipped` test is the
  // honest single-pass signal ("no project verification ran") and must NOT hard-fail
  // the gate — the platform footer surfaces it as "검증 없음 (verification skipped)".
  // A wholly missing `tests` array (no evidence at all) is also treated as skipped,
  // not blocking, because the runner schema now always emits an explicit status.
  if (result.tests.some((test) => test.status === "failed")) {
    reasons.push("Verification failed");
  }

  // X7 secret scan: inspect the agent's diff evidence (changed file paths, commit
  // messages, test summaries, the PR draft title) for leaked credentials. Any hit
  // blocks the gate — a secret in the change is never an acceptable PR.
  const secretFindings = scanForSecrets(collectSecretScanTargets(result));
  if (secretFindings.length > 0) {
    const rules = [...new Set(secretFindings.map((finding) => finding.rule))].join(", ");
    reasons.push(`Potential secrets detected in diff (${rules})`);
  }

  const allowed = reasons.length === 0;
  return {
    allowed,
    reason: allowed ? undefined : reasons.join("; "),
    artifact: {
      status: allowed ? "passed" : "failed",
      repository: input.repository,
      repositoryAllowed,
      changedFiles,
      deniedFiles,
      reasons,
      verification: summarizeVerification(result.tests),
      secretFindings,
    },
  };
}
