import { isProtectedPath, isRepositoryAllowed } from "@ticket-to-pr/core";
import type { AgentResult } from "@ticket-to-pr/core";

export interface WorkerPolicyConfig {
  repositoryAllowlist: string[];
  protectedPathDenylist: string[];
}

export interface PolicyGateInput extends WorkerPolicyConfig {
  repository: string;
  expectedTargetBranch?: string;
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
  reason?: string;
  artifact: PolicyGateArtifact;
}

export function evaluatePreExecutionPolicy(input: PolicyGateInput): PolicyGateResult {
  const repositoryAllowed = isRepositoryAllowed(input.repository, input.repositoryAllowlist);
  const reasons = repositoryAllowed ? [] : [`Repository is not allowlisted: ${input.repository}`];
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
    },
  };
}
