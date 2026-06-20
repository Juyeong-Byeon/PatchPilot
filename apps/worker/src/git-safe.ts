export function buildSafeGitArgs(args: string[], safeDirectory?: string): string[] {
  return safeDirectory ? ["-c", `safe.directory=${safeDirectory}`, ...args] : args;
}
