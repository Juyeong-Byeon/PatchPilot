export function isRepositoryAllowed(repository: string, allowlist: string[]): boolean {
  return allowlist.includes(repository);
}

export function isProtectedPath(path: string, denylist: string[]): boolean {
  return denylist.some((pattern) => {
    if (pattern.endsWith("/**")) {
      const basePath = pattern.slice(0, -3);
      return path === basePath || path.startsWith(`${basePath}/`);
    }
    if (pattern.endsWith(".*")) return path === pattern.slice(0, -2) || path.startsWith(pattern.slice(0, -1));
    return path === pattern;
  });
}
