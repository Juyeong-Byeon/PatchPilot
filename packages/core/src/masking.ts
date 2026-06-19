const patterns: Array<[RegExp, string]> = [
  [/github_pat_[A-Za-z0-9_]+/g, "[REDACTED_GITHUB_TOKEN]"],
  [/gh[pousr]_[A-Za-z0-9_]+/g, "[REDACTED_GITHUB_TOKEN]"],
  [/(LARK_APP_SECRET=)[^\s]+/g, "$1[REDACTED_LARK_SECRET]"],
  [/(GITHUB_TOKEN=)[^\s]+/g, "$1[REDACTED_GITHUB_TOKEN]"]
];

const partialPrefixes = ["github_pat_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "GITHUB_TOKEN=", "LARK_APP_SECRET="];

export function maskSecrets(text: string): string {
  return patterns.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
}

export function createSecretRedactor(): (chunk: string, flush?: boolean) => string {
  let pending = "";

  return (chunk: string, flush = false): string => {
    pending += chunk;
    const emitLength = flush ? pending.length : safeEmitLength(pending);
    const output = pending.slice(0, emitLength);
    pending = pending.slice(emitLength);
    return maskSecrets(output);
  };
}

function safeEmitLength(value: string): number {
  let holdIndex = value.length;

  for (const prefix of partialPrefixes) {
    const partialStart = Math.max(0, value.length - prefix.length + 1);
    for (let index = partialStart; index < value.length; index += 1) {
      if (prefix.startsWith(value.slice(index))) {
        holdIndex = Math.min(holdIndex, index);
      }
    }

    let index = value.indexOf(prefix);
    while (index !== -1) {
      if (!hasTerminator(value.slice(index + prefix.length))) {
        holdIndex = Math.min(holdIndex, index);
      }
      index = value.indexOf(prefix, index + 1);
    }
  }

  return holdIndex;
}

function hasTerminator(value: string): boolean {
  return /[^A-Za-z0-9_=]/.test(value);
}
