export interface PolicyConfig {
  repositoryAllowlist: string[];
  protectedPathDenylist: string[];
}

export function isRepositoryAllowed(repository: string, allowlist: string[]): boolean {
  return allowlist.includes(repository);
}

export function isProtectedPath(path: string, denylist: string[]): boolean {
  return denylist.some((pattern) => {
    if (pattern.endsWith("/**")) return path.startsWith(pattern.slice(0, -3));
    if (pattern.endsWith(".*")) return path === pattern.slice(0, -2) || path.startsWith(pattern.slice(0, -1));
    return path === pattern;
  });
}
