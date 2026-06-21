import type { ReactElement } from "react";
import type { VersionInfo } from "../api.js";
import type { AdminCopy } from "../i18n.js";

interface VersionBadgeProps {
  // The running build's version + git SHA, or null while it is loading / unavailable
  // (the GET /api/version fetch is informational and never blocks the shell).
  version: VersionInfo | null;
  copy: AdminCopy;
}

// Git SHAs are abbreviated to their first 7 characters, matching how `git log --oneline`
// and GitHub display short commit hashes — long enough to be unambiguous, short enough
// to glance at in the footer.
const SHORT_SHA_LENGTH = 7;

/**
 * Subtle deployed-build stamp for the sidebar footer (X · operator introspection).
 * Renders e.g. "v0.1.0 · 1a2b3c4" so operators can verify which build is serving
 * traffic at a glance. When the SHA is null (e.g. local dev, no GIT_SHA) only the
 * version shows — no trailing separator. Renders nothing until version info is
 * available so a slow/absent `/api/version` never leaves a broken element behind.
 */
export function VersionBadge({ version, copy }: VersionBadgeProps): ReactElement | null {
  if (!version) return null;

  const shortSha = version.sha ? version.sha.slice(0, SHORT_SHA_LENGTH) : null;

  return (
    <p className="m-0 mt-1 font-mono text-[11px] leading-4 text-graphite tabular-nums" aria-label={copy.versionLabel}>
      <span>v{version.version}</span>
      {shortSha ? <span> · {shortSha}</span> : null}
    </p>
  );
}
