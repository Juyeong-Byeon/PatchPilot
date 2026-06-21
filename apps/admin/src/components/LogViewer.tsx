import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Download, X } from "lucide-react";
import type { LogLine } from "../api.js";
import type { AdminCopy } from "../i18n.js";
import { isStageBannerText } from "../lib/status.js";
import { cn } from "../lib/utils.js";
import { Button } from "./ui/button.js";
import { Card, CardTitle } from "./ui/card.js";
import { Input } from "./ui/input.js";
import { Select } from "./ui/select.js";

interface LogViewerProps {
  logs: LogLine[];
  totalCount?: number;
  copy: AdminCopy;
  jobId?: string;
  contextLabel?: string;
  onClearContext?(): void;
  variant?: "card" | "embedded";
}

export function LogViewer({
  logs,
  totalCount,
  copy,
  jobId,
  contextLabel,
  onClearContext,
  variant = "card",
}: LogViewerProps) {
  const [source, setSource] = useState("all");
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);
  const sources = useMemo(
    () => Array.from(new Set(logs.map((line) => line.source).filter(Boolean) as string[])).sort(),
    [logs],
  );
  const filteredLogs = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return logs.filter((line) => {
      const sourceMatches = source === "all" || line.source === source;
      const queryMatches = !needle || (line.text ?? "").toLowerCase().includes(needle);
      return sourceMatches && queryMatches;
    });
  }, [logs, query, source]);
  const text = filteredLogs.map((line) => formatLine(line, copy)).join("\n");

  // Briefly show a "copied" confirmation after a successful clipboard write.
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(id);
  }, [copied]);

  async function copyLogs(): Promise<void> {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard write denied/unavailable — leave the button in its default state.
    }
  }

  const shellClassName =
    variant === "embedded" ? "surface-card-soft rounded-xl border border-hairline-gray bg-linen-white" : "";

  const content = (
    <>
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? copy.copied : ""}
      </span>
      <div className="flex flex-col items-stretch justify-between gap-3 border-b border-hairline-gray p-4 xl:flex-row xl:items-center">
        <div>
          <CardTitle>{copy.logs}</CardTitle>
          <span className="text-[12px] leading-4 text-charcoal">
            {filteredLogs.length}/{totalCount ?? logs.length}
          </span>
        </div>
        <div className="grid gap-2 md:grid-cols-[150px_minmax(180px,1fr)_auto_auto]">
          <Select aria-label={copy.filterLogsLabel} value={source} onChange={(event) => setSource(event.target.value)}>
            <option value="all">{copy.allSources}</option>
            {sources.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </Select>
          <Input
            aria-label={copy.searchLogsLabel}
            value={query}
            placeholder={copy.searchLogsPlaceholder}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={copied ? copy.copied : copy.copy}
            title={copied ? copy.copied : copy.copy}
            onClick={() => void copyLogs()}
          >
            {copied ? (
              <Check data-icon aria-hidden="true" strokeWidth={2.2} />
            ) : (
              <Copy data-icon aria-hidden="true" strokeWidth={2.2} />
            )}
          </Button>
          <Button
            type="button"
            size="icon"
            aria-label={copy.download}
            title={copy.download}
            onClick={() => downloadText(text, jobId)}
          >
            <Download data-icon aria-hidden="true" strokeWidth={2.2} />
          </Button>
        </div>
      </div>
      {contextLabel ? (
        <div className="flex items-center justify-between gap-3 border-b border-hairline-gray bg-linen px-4 py-2 text-[12px] text-charcoal">
          <span>
            {copy.correlatedLogs}: {contextLabel}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={copy.clear}
            title={copy.clear}
            onClick={onClearContext}
          >
            <X data-icon aria-hidden="true" strokeWidth={2.2} />
          </Button>
        </div>
      ) : null}
      <div>
        <pre
          tabIndex={0}
          role="group"
          aria-label={copy.logs}
          className="terminal-surface m-0 max-h-[320px] min-h-[180px] overflow-auto p-4 text-[12px] leading-5 whitespace-pre-wrap text-true-black"
        >
          {filteredLogs.length === 0 ? (
            <p className="m-0" role="status">
              {copy.noLogs}
            </p>
          ) : (
            filteredLogs.map((line, index) => (
              <span
                key={String(line.id ?? index)}
                className={cn("block", isStageBannerText(line.text) && "mt-1 font-semibold text-cobalt-surface")}
              >
                {formatLine(line, copy)}
              </span>
            ))
          )}
        </pre>
      </div>
    </>
  );

  if (variant === "embedded") {
    return (
      <section className={shellClassName} aria-label={copy.logs}>
        {content}
      </section>
    );
  }

  return <Card>{content}</Card>;
}

function formatLine(line: LogLine, copy: AdminCopy): string {
  const time = line.created_at ?? "-";
  const stream = line.stream ?? copy.logDefaultStream;
  if (stream === "progress") return `[${time}] ${line.text ?? ""}`;

  const source = line.source ?? copy.sourceSystem;
  const sequence = line.sequence ?? "-";
  const redacted = line.redaction_applied ? ` ${copy.redacted}` : "";
  return `[${time}] [${source}/${stream} #${sequence}${redacted}] ${line.text ?? ""}`;
}

function downloadText(text: string, jobId?: string): void {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  const uuid = jobId?.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? jobId;
  anchor.download = uuid ? `patchpilot-${uuid}.log` : "patchpilot-job.log";
  anchor.click();
  URL.revokeObjectURL(url);
}
