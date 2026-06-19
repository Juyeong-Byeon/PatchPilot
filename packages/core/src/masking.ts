const patterns: Array<[RegExp, string]> = [
  [/github_pat_[A-Za-z0-9_]+/g, "[REDACTED_GITHUB_TOKEN]"],
  [/ghp_[A-Za-z0-9_]+/g, "[REDACTED_GITHUB_TOKEN]"],
  [/(LARK_APP_SECRET=)[^\s]+/g, "$1[REDACTED_LARK_SECRET]"],
  [/(GITHUB_TOKEN=)[^\s]+/g, "$1[REDACTED_GITHUB_TOKEN]"]
];

export function maskSecrets(text: string): string {
  return patterns.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
}
