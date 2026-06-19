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

export interface PolicyGateArtifact {
  status: "passed" | "failed";
  repository: string;
  repositoryAllowed: boolean;
  changedFiles: string[];
  deniedFiles: string[];
  reasons: string[];
}

export interface PolicyGateResult {
  allowed: boolean;
  reason?: string;
  artifact: PolicyGateArtifact;
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
    reasons.push(`Target branch mismatch: expected ${input.expectedTargetBranch}, got ${result.targetBranch ?? "unknown"}`);
  }
  if (result.commits.length === 0) {
    reasons.push("No local commit evidence was produced");
  }
  if (!result.pullRequestDraft?.title || !result.pullRequestDraft.bodyPath) {
    reasons.push("PR draft is missing");
  }
  if (result.tests.length === 0 || result.tests.every((test) => test.status !== "passed")) {
    reasons.push("Verification evidence is missing");
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
      reasons
    }
  };
}
