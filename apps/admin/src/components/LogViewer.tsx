import { useMemo, useState } from "react";
import type { LogLine } from "../api.js";
import type { AdminCopy } from "../i18n.js";
import { Button } from "./ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.js";
import { Input } from "./ui/input.js";
import { Select } from "./ui/select.js";

interface LogViewerProps {
  logs: LogLine[];
  copy: AdminCopy;
  highlightSource?: string;
  onClearHighlight?(): void;
}

export function LogViewer({ logs, copy, highlightSource, onClearHighlight }: LogViewerProps) {
  const [source, setSource] = useState("all");
  const [query, setQuery] = useState("");
  const sources = useMemo(
    () => Array.from(new Set(logs.map((line) => line.source).filter(Boolean) as string[])).sort(),
    [logs]
  );
  const filteredLogs = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return logs.filter((line) => {
      const sourceMatches = source === "all" || line.source === source;
      const highlightMatches = !highlightSource || line.source === highlightSource;
      const queryMatches = !needle || (line.text ?? "").toLowerCase().includes(needle);
      return sourceMatches && highlightMatches && queryMatches;
    });
  }, [highlightSource, logs, query, source]);
  const text = filteredLogs.map((line) => formatLine(line, copy)).join("\n");

  return (
    <Card>
      <CardHeader className="flex-col items-stretch xl:flex-row xl:items-center">
        <div>
          <CardTitle>{copy.logs}</CardTitle>
          <span className="text-xs text-charcoal">{filteredLogs.length}/{logs.length}</span>
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
          <Button type="button" variant="outline" onClick={() => void navigator.clipboard?.writeText(text)}>
            {copy.copy}
          </Button>
          <Button type="button" onClick={() => downloadText(text)}>
            {copy.download}
          </Button>
        </div>
      </CardHeader>
      {highlightSource ? (
        <div className="flex items-center justify-between gap-3 border-b border-hairline-gray bg-linen px-5 py-2 text-xs text-charcoal">
          <span>{copy.correlatedLogs}: {highlightSource}</span>
          <Button type="button" variant="ghost" size="sm" onClick={onClearHighlight}>
            {copy.clear}
          </Button>
        </div>
      ) : null}
      <CardContent className="p-0">
        <pre className="m-0 max-h-[320px] min-h-[180px] overflow-auto border-t border-hairline-gray bg-linen p-4 text-xs leading-normal whitespace-pre-wrap text-true-black">{text || copy.noLogs}</pre>
      </CardContent>
    </Card>
  );
}

function formatLine(line: LogLine, copy: AdminCopy): string {
  const time = line.created_at ?? "-";
  const source = line.source ?? copy.sourceSystem;
  const stream = line.stream ?? copy.logDefaultStream;
  const sequence = line.sequence ?? "-";
  const redacted = line.redaction_applied ? ` ${copy.redacted}` : "";
  return `[${time}] [${source}/${stream} #${sequence}${redacted}] ${line.text ?? ""}`;
}

function downloadText(text: string): void {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "ticket-to-pr-job.log";
  anchor.click();
  URL.revokeObjectURL(url);
}
