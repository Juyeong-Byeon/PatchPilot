import type { ReactElement } from "react";
import { Cable } from "lucide-react";
import type { VersionInfo } from "../api.js";
import type { AdminCopy } from "../i18n.js";
import { cn } from "../lib/utils.js";

interface ConnectionBadgeProps {
  frontendOrigin: string;
  apiDisplayUrl: string;
  requestMode: "direct" | "proxy";
  version: VersionInfo | null;
  copy: AdminCopy;
  className?: string;
}

const SHORT_SHA_LENGTH = 7;

export function ConnectionBadge({
  frontendOrigin,
  apiDisplayUrl,
  requestMode,
  version,
  copy,
  className,
}: ConnectionBadgeProps): ReactElement {
  const runtime =
    version?.nodeEnv || version?.executorMode || version?.publisherMode
      ? [
          version.nodeEnv,
          version.executorMode && version.publisherMode ? `${version.executorMode}/${version.publisherMode}` : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : copy.unknown;
  const build = version ? formatBuild(version) : copy.unknown;
  const requestLabel = requestMode === "direct" ? copy.connectionDirect : copy.connectionProxy;

  return (
    <section
      aria-label={copy.connectionLabel}
      className={cn(
        "min-w-0 rounded-lg border border-hairline-gray bg-linen-white/92 px-3 py-2 text-[11px] leading-4 text-charcoal shadow-sm shadow-midnight-ink/5",
        className,
      )}
    >
      <div className="mb-1 flex items-center gap-1.5 font-semibold text-forest-ink">
        <Cable aria-hidden="true" size={14} strokeWidth={2.2} />
        <span>{copy.connectionLabel}</span>
      </div>
      <dl className="grid gap-1">
        <ConnectionRow label={copy.connectionFrontend} value={frontendOrigin || copy.unknown} />
        <ConnectionRow label={copy.connectionApi} value={apiDisplayUrl || copy.unknown} />
        <ConnectionRow label={copy.connectionRequest} value={requestLabel} />
        <ConnectionRow label={copy.connectionRuntime} value={runtime} />
        <ConnectionRow label={copy.connectionBuild} value={build} />
      </dl>
    </section>
  );
}

function ConnectionRow({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="grid min-w-0 grid-cols-[4.25rem_minmax(0,1fr)] gap-2">
      <dt className="text-graphite">{label}</dt>
      <dd className="m-0 truncate font-mono text-forest-ink" title={value}>
        {value}
      </dd>
    </div>
  );
}

function formatBuild(version: VersionInfo): string {
  const shortSha = version.sha ? version.sha.slice(0, SHORT_SHA_LENGTH) : null;
  return shortSha ? `v${version.version} · ${shortSha}` : `v${version.version}`;
}
