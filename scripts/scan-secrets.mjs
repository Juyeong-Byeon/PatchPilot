#!/usr/bin/env node
// CI secret scanner — blocks a merge when a committed secret is detected.
//
// Scans git-tracked text files for well-known credential shapes and exits 1 on
// any finding. Self-contained (no build step, no external dependency) so it can
// run as a fast, independent merge gate even when the build is broken.
//
// The rules are the high-confidence subset of the runtime policy-gate scanner in
// apps/worker/src/secret-scan.ts (X7) — credential shapes anchored on real
// prefixes/structures. The runtime gate's broader `generic-secret-assignment`
// heuristic is intentionally omitted here: it scans the agent's narrow trusted
// evidence, whereas this gate scans the whole repo where `token: "..."`-style
// assignments are overwhelmingly false positives that would erode a merge gate.
//
// Suppressing a false positive: add `secret-scan:allow` on the offending line, or
// add the path to ALLOWLIST_PATHS below (use only for files that hold fixtures by
// design, e.g. the scanner's own tests).

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Detection rules — the high-confidence subset of apps/worker/src/secret-scan.ts
// SECRET_RULES (see header note on why the generic rule is omitted here).
export const SECRET_RULES = [
  {
    name: "aws-access-key-id",
    pattern: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b/g,
  },
  { name: "aws-secret-access-key", pattern: /aws_secret_access_key\s*[=:]\s*['"]?[A-Za-z0-9/+]{40}['"]?/gi },
  { name: "private-key-header", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { name: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { name: "github-fine-grained-token", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "stripe-secret-key", pattern: /\b(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{16,}\b/g },
  { name: "openai-key", pattern: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
];

// Inline escape hatch — a line containing this marker is never flagged.
const INLINE_ALLOW = "secret-scan:allow";

// Files that hold credential-shaped fixtures by design. The scanner's own source
// and tests would otherwise flag their rule patterns / sample secrets.
const ALLOWLIST_PATHS = [
  "scripts/scan-secrets.mjs",
  "scripts/scan-secrets.test.ts",
  "apps/worker/src/secret-scan.ts",
  "apps/worker/test/secret-scan.test.ts",
];

// Binary / noise extensions never worth scanning (also avoids false hits in blobs).
const SKIP_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "svg",
  "pdf",
  "woff",
  "woff2",
  "ttf",
  "eot",
  "zip",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "lock",
  "wasm",
  "node",
  "map",
]);

const MAX_FILE_BYTES = 1_000_000; // skip very large files (likely generated/blobs)

export function maskMatch(value) {
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-2)} [${value.length} chars]`;
}

/** Scan a single text blob. Returns [{ rule, line, maskedSnippet }]. */
export function scanText(text) {
  const findings = [];
  const seen = new Set();
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    if (line.includes(INLINE_ALLOW)) return;
    for (const rule of SECRET_RULES) {
      rule.pattern.lastIndex = 0;
      let match;
      while ((match = rule.pattern.exec(line)) !== null) {
        const masked = maskMatch(match[0]);
        const key = `${rule.name}:${index}:${masked}`;
        if (!seen.has(key)) {
          seen.add(key);
          findings.push({ rule: rule.name, line: index + 1, maskedSnippet: masked });
        }
        if (match.index === rule.pattern.lastIndex) rule.pattern.lastIndex += 1;
      }
    }
  });
  return findings;
}

function isAllowlisted(path) {
  return ALLOWLIST_PATHS.includes(path);
}

function isScannable(path) {
  const ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "";
  return !SKIP_EXTENSIONS.has(ext);
}

export function listTrackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\u0000").filter(Boolean);
}

/** Scan the working tree's tracked files. Returns [{ file, rule, line, maskedSnippet }]. */
export function scanRepo(files = listTrackedFiles()) {
  const findings = [];
  for (const file of files) {
    if (isAllowlisted(file) || !isScannable(file)) continue;
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue; // deleted-but-tracked, symlink, etc.
    }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue; // binary
    for (const hit of scanText(text)) findings.push({ file, ...hit });
  }
  return findings;
}

function main() {
  const findings = scanRepo();
  if (findings.length === 0) {
    console.log("OK secret scan: no secrets detected in tracked files.");
    return 0;
  }
  console.error(`FAIL secret scan: ${findings.length} potential secret(s) detected:\n`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.rule}]  ${f.maskedSnippet}`);
  }
  console.error(
    "\nRemove the secret and rotate it. If this is a false positive, add `secret-scan:allow` " +
      "on the line, or allowlist the path in scripts/scan-secrets.mjs.",
  );
  return 1;
}

// Run only when invoked directly (not when imported by the test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
