export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "ticket";
}

export function createWorkBranchName(recordId: string, title: string, attempt?: number): string {
  const safeRecord = recordId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  const suffix = attempt && attempt > 1 ? `-${attempt}` : "";
  return `agent/${safeRecord}-${slugifyTitle(title)}${suffix}`;
}
