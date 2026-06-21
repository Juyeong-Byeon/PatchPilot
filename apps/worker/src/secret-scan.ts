import { maskSecrets } from "@ticket-to-pr/core";
import type { AgentResult } from "@ticket-to-pr/core";

/**
 * Secret scan (X7). A single hit blocks the policy gate. The scan runs over the
 * platform's *trusted* diff evidence (changed file paths, commit messages, test
 * summaries, the PR draft title) rather than agent-claimed prose, so it cannot be
 * talked out of by the agent. Findings record the rule and a masked snippet only —
 * the raw secret is never persisted.
 */
export interface SecretFinding {
  /** Which detection rule fired (e.g. "aws-access-key-id"). */
  rule: string;
  /** A short, secret-masked snippet of the matched region for the audit trail. */
  maskedSnippet: string;
}

interface SecretRule {
  name: string;
  pattern: RegExp;
}

// Minimum-bar rule set required by X7: AWS keys, private-key headers, and common
// token patterns. Patterns are intentionally conservative (anchored on
// well-known prefixes / structures) to keep false positives low.
const SECRET_RULES: SecretRule[] = [
  // AWS access key id: AKIA/ASIA/AGPA/... + 16 base32 chars.
  {
    name: "aws-access-key-id",
    pattern: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b/g,
  },
  // AWS secret access key, surfaced when adjacent to an aws secret assignment.
  {
    name: "aws-secret-access-key",
    pattern: /aws_secret_access_key\s*[=:]\s*['"]?[A-Za-z0-9/+]{40}['"]?/gi,
  },
  // PEM private-key header for any key type.
  { name: "private-key-header", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  // GitHub tokens (classic + fine-grained) and OAuth/app/refresh variants.
  { name: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { name: "github-fine-grained-token", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  // Slack tokens.
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  // Google API key.
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // Stripe live/test secret keys.
  { name: "stripe-secret-key", pattern: /\b(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{16,}\b/g },
  // OpenAI-style secret keys.
  { name: "openai-key", pattern: /\bsk-[A-Za-z0-9]{20,}\b/g },
  // JWT (three base64url segments).
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  // Generic high-entropy assignment to a secret-named key.
  {
    name: "generic-secret-assignment",
    pattern: /\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*['"][^'"\s]{8,}['"]/gi,
  },
];

/**
 * Scan an array of (already-trusted) text fragments for secrets. Returns one
 * finding per (rule, match), deduplicated by masked snippet so a repeated secret
 * does not flood the artifact. Empty array means clean.
 */
export function scanForSecrets(texts: Array<string | undefined>): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const rule of SECRET_RULES) {
      // Reset stateful global regex between inputs.
      rule.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = rule.pattern.exec(text)) !== null) {
        const maskedSnippet = maskSecrets(snippetAround(text, match.index, match[0].length));
        const key = `${rule.name}:${maskedSnippet}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({ rule: rule.name, maskedSnippet });
        // Guard against zero-length matches looping forever.
        if (match.index === rule.pattern.lastIndex) rule.pattern.lastIndex += 1;
      }
    }
  }
  return findings;
}

/**
 * Pull every trusted text fragment off a completed AgentResult that could carry a
 * leaked secret: changed file paths, commit messages, test commands/summaries, and
 * the PR draft title. (The PR body itself is masked separately by the footer
 * composer; here we cover the structured evidence.)
 */
export function collectSecretScanTargets(result: AgentResult): string[] {
  const targets: string[] = [];
  for (const file of result.changedFiles) targets.push(file);
  for (const commit of result.commits) targets.push(commit.message);
  for (const test of result.tests) {
    targets.push(test.command);
    if (test.summary) targets.push(test.summary);
  }
  if (result.pullRequestDraft?.title) targets.push(result.pullRequestDraft.title);
  return targets;
}

// A small window around the match, so the masked snippet has context without
// dumping a whole file. Trimmed to keep artifacts compact.
function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 8);
  const end = Math.min(text.length, index + length + 8);
  return text.slice(start, end);
}
