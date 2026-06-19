import { useMemo, useState } from "react";
import type { LogLine } from "../api.js";

interface LogViewerProps {
  logs: LogLine[];
}

export function LogViewer({ logs }: LogViewerProps) {
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
      const queryMatches = !needle || (line.text ?? "").toLowerCase().includes(needle);
      return sourceMatches && queryMatches;
    });
  }, [logs, query, source]);
  const text = filteredLogs.map(formatLine).join("\n");

  return (
    <section className="panel log-panel">
      <div className="panel-header">
        <div>
          <h2>Logs</h2>
          <span>{filteredLogs.length}/{logs.length}</span>
        </div>
        <div className="log-controls">
          <select aria-label="Filter logs by source" value={source} onChange={(event) => setSource(event.target.value)}>
            <option value="all">All sources</option>
            {sources.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
          <input
            aria-label="Search logs"
            value={query}
            placeholder="Search logs"
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="button" onClick={() => void navigator.clipboard?.writeText(text)}>
            Copy
          </button>
          <button type="button" onClick={() => downloadText(text)}>
            Download
          </button>
        </div>
      </div>
      <pre className="logs">{text || "No logs recorded."}</pre>
    </section>
  );
}

function formatLine(line: LogLine): string {
  const time = line.created_at ?? "-";
  const source = line.source ?? "system";
  const stream = line.stream ?? "log";
  const sequence = line.sequence ?? "-";
  const redacted = line.redaction_applied ? " redacted" : "";
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
