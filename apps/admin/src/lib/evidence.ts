import type { Artifact, JobRecord } from "../api.js";

// Normalized, presentational view of the trust evidence the worker records as
// artifacts. Built defensively from `agent-result` (executor evidence) and
// `policy-gate` (gate verdict) so the JobDetail evidence card never depends on a
// specific artifact ordering and degrades gracefully when a field is absent.

export interface TestEvidence {
  command: string;
  status: "passed" | "failed" | "skipped" | "unknown";
  summary?: string;
}

export interface JobEvidence {
  /** Whether any policy/result artifact was found at all. */
  present: boolean;
  changedFiles: string[];
  changedFileCount: number;
  /** Protected-path violations. Empty array => "보호경로 위반 0". */
  deniedFiles: string[];
  policyStatus: "passed" | "failed" | "unknown";
  policyReasons: string[];
  tests: TestEvidence[];
  /** Overall verification verdict derived from the tests array. */
  verification: "passed" | "skipped" | "failed" | "none";
  baseSha?: string;
  headSha?: string;
  /** Target branch recorded by the executor (audited), if any. */
  targetBranch?: string;
}

function kindOf(artifact: Artifact): string {
  return String(artifact.kind ?? "").toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function fullSha(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{7,40}$/i.test(value) ? value : undefined;
}

function parseTests(value: unknown): TestEvidence[] {
  if (!Array.isArray(value)) return [];
  const tests: TestEvidence[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const command = typeof record.command === "string" ? record.command : "";
    const rawStatus = String(record.status ?? "");
    const status: TestEvidence["status"] =
      rawStatus === "passed" || rawStatus === "failed" || rawStatus === "skipped" ? rawStatus : "unknown";
    const summary = typeof record.summary === "string" ? record.summary : undefined;
    if (!command && status === "unknown") continue;
    tests.push({ command: command || "—", status, summary });
  }
  return tests;
}

function deriveVerification(tests: TestEvidence[]): JobEvidence["verification"] {
  if (tests.length === 0) return "none";
  if (tests.some((test) => test.status === "failed")) return "failed";
  if (tests.some((test) => test.status === "passed")) return "passed";
  // Tests exist but none passed and none failed => all skipped/unknown: explicitly
  // surfaced as "검증 없음" so a single-pass run's skipped tests are not mistaken
  // for a real green signal.
  return "skipped";
}

/**
 * Build the evidence view from a run's artifacts. The most recent matching
 * artifact wins (artifacts arrive in chronological order). Returns
 * `present: false` only when neither a policy-gate nor an agent-result artifact
 * carrying usable evidence is found.
 */
export function extractJobEvidence(artifacts: Artifact[]): JobEvidence {
  let policy: Record<string, unknown> | null = null;
  let result: Record<string, unknown> | null = null;

  for (const artifact of artifacts) {
    const kind = kindOf(artifact);
    const content = asRecord(artifact.content);
    if (!content) continue;
    if (kind.includes("policy")) policy = content;
    else if (kind.includes("agent-result") || kind === "result") result = content;
  }

  const policyChanged = policy ? stringArray(policy.changedFiles) : [];
  const resultChanged = result ? stringArray(result.changedFiles) : [];
  const changedFiles = policyChanged.length > 0 ? policyChanged : resultChanged;
  const deniedFiles = policy ? stringArray(policy.deniedFiles) : [];
  const tests = parseTests(result?.tests);

  const policyStatusRaw = policy ? String(policy.status ?? "") : "";
  const policyStatus: JobEvidence["policyStatus"] =
    policyStatusRaw === "passed" || policyStatusRaw === "failed" ? policyStatusRaw : "unknown";

  return {
    present: Boolean(policy || result),
    changedFiles,
    changedFileCount: changedFiles.length,
    deniedFiles,
    policyStatus,
    policyReasons: policy ? stringArray(policy.reasons) : [],
    tests,
    verification: deriveVerification(tests),
    baseSha: fullSha(result?.baseSha),
    headSha: fullSha(result?.headSha),
    targetBranch: typeof result?.targetBranch === "string" ? result.targetBranch : undefined,
  };
}

// Split a definition-of-done string into discrete checklist items when it is
// enumerable (markdown bullets, numbered lists, or one-per-line). Returns an
// empty array when the text is a single free-form paragraph so the caller can
// fall back to rendering the raw prose. Purely presentational — no state.
export function parseDefinitionOfDone(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  // A single physical line that packs several "N)" criteria, e.g.
  // "1) 버튼 추가 2) 완료만 제거 3) 비활성화" — split into one item per number so each
  // DoD criterion is independently scannable instead of a crammed run-on line. Runs
  // before the bullet check below, which (the line starts with "1)") would otherwise
  // return the whole line as a single item.
  if (lines.length === 1) {
    const inline = splitInlineEnumeration(lines[0] ?? "");
    if (inline.length >= 2) return inline;
  }

  const bulletPattern = /^(?:[-*+]|\d+[.)]|\[[ xX]?\])\s+/;
  const bulletLines = lines.filter((line) => bulletPattern.test(line));

  // Treat as a checklist only when most lines look like list items, or when there
  // are several plain lines (each line = one criterion). A lone paragraph stays prose.
  const stripped = (line: string) =>
    line
      .replace(bulletPattern, "")
      .replace(/^\[[ xX]?\]\s*/, "")
      .trim();
  if (bulletLines.length >= 2 || (bulletLines.length >= 1 && lines.length === bulletLines.length)) {
    return bulletLines.map(stripped).filter(Boolean);
  }
  if (lines.length >= 2) return lines.map(stripped).filter(Boolean);
  return [];
}

// Split an inline "1) … 2) … 3) …" enumeration into its items. Paren-style only
// (not "1.") so version strings like "v1.2" can never be mistaken for a list.
function splitInlineEnumeration(text: string): string[] {
  const matches = [...text.matchAll(/(?:^|\s)\d+\)\s*(.+?)(?=\s+\d+\)\s|$)/gs)];
  if (matches.length < 2) return [];
  return matches.map((match) => (match[1] ?? "").trim()).filter(Boolean);
}

// Forward-compat: surface an executor/pipeline mode badge ONLY when the backend
// record actually carries the field (added later by another track). Returns null
// when absent so the caller renders nothing and never crashes.
export type ExecutorMode = "single-pass" | "staged" | string;

export function readExecutorMode(job: JobRecord | null | undefined): ExecutorMode | null {
  if (!job) return null;
  const raw = job.executorMode ?? job.executor_mode ?? job.pipelineMode ?? job.pipeline_mode;
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

// Build the GitHub "Files changed" tab URL for a PR from its pr_url. Returns null
// when the pr_url is absent or not a recognizable GitHub PR URL, so the caller can
// render a plain (non-linked) file path instead of a broken link.
export function prFilesUrl(prUrl: unknown): string | null {
  if (typeof prUrl !== "string") return null;
  const trimmed = prUrl.trim();
  // .../owner/repo/pull/<n>  (tolerate a trailing slash or existing /files suffix)
  const match = trimmed.match(/^(https?:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/\d+)(?:\/.*)?$/i);
  if (!match) return null;
  return `${match[1]}/files`;
}

// Per-file deeplink into a PR's diff. GitHub anchors each file as
// `#diff-<sha256hex(path)>`; the SHA is computed asynchronously by the caller (it
// needs SubtleCrypto). When the anchor isn't available yet, we still return the
// Files tab URL, which is a valid, non-broken link — so the link degrades to the
// PR file list rather than failing.
export function prFileDeepLink(filesUrl: string, anchorHex: string | undefined): string {
  return anchorHex ? `${filesUrl}#diff-${anchorHex}` : filesUrl;
}

// Map a raw mode token to a stable display key. Unknown tokens pass through so a
// future mode value still renders (just without a localized label).
export function normalizeExecutorMode(mode: ExecutorMode): "single-pass" | "staged" | "other" {
  const value = mode.toLowerCase().replace(/[\s_]+/g, "-");
  if (value === "single-pass" || value === "single" || value === "singlepass" || value === "codex")
    return "single-pass";
  if (value === "staged" || value === "gstack" || value === "multi-pass") return "staged";
  return "other";
}
