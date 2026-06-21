import { useEffect, useRef, useState } from "react";
import { fetchMetrics, type JobMetrics } from "../api.js";
import { executorModeLabel, type AdminCopy } from "../i18n.js";
import { normalizeExecutorMode } from "../lib/evidence.js";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.js";

interface MetricsPanelProps {
  token: string;
  copy: AdminCopy;
  // Frozen once the session expires so the panel stops issuing requests, matching
  // the app-wide re-auth boundary.
  sessionExpired: boolean;
  // Bubble a 401 up so the single re-auth boundary in App can take over.
  onSessionExpired(): void;
}

/**
 * Compact operations-metrics summary (X5 frontend). The `GET /api/metrics`
 * endpoint is delivered by a separate backend track and may not exist yet, so this
 * panel is defensive end-to-end:
 *  - On 404 / network / non-JSON / any non-OK → render nothing (panel hidden).
 *  - On 401 → defer to the app's re-auth boundary, render nothing.
 *  - Only when usable data is present do any tiles render; each tile shows only
 *    when its field exists, so a partial payload never blanks a slot.
 */
export function MetricsPanel({ token, copy, sessionExpired, onSessionExpired }: MetricsPanelProps) {
  const [metrics, setMetrics] = useState<JobMetrics | null>(null);

  // Keep the latest callback in a ref so the fetch effect depends only on the
  // token/session — not on the parent re-creating the handler each render (which
  // would otherwise re-fetch metrics on every App render).
  const onSessionExpiredRef = useRef(onSessionExpired);
  onSessionExpiredRef.current = onSessionExpired;

  useEffect(() => {
    if (!token.trim() || sessionExpired) {
      setMetrics(null);
      return;
    }

    let cancelled = false;
    void fetchMetrics(token)
      .then((data) => {
        if (!cancelled) setMetrics(data);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // A stale token here routes through the same single re-auth boundary as
        // every other request path; everything else just hides the panel.
        if (error instanceof Error && error.message === "admin_access_key_invalid") {
          onSessionExpiredRef.current();
        }
        setMetrics(null);
      });

    return () => {
      cancelled = true;
    };
  }, [token, sessionExpired]);

  const tiles = metrics ? buildTiles(metrics, copy) : [];
  const modeEntries = metrics ? executorModeEntries(metrics.executorModeDistribution) : [];

  // Render only when the endpoint returned something usable. An empty/absent
  // payload (no rate, no runtime, no distribution) leaves the panel hidden.
  if (!metrics || (tiles.length === 0 && modeEntries.length === 0)) return null;

  return (
    <Card aria-label={copy.metricsTitle}>
      <CardHeader>
        <div>
          <CardTitle>{copy.metricsTitle}</CardTitle>
          <span className="mt-1 block text-[12px] leading-4 text-charcoal">
            {typeof metrics.totalJobs === "number" ? copy.metricsSampleSize(metrics.totalJobs) : copy.metricsSubtitle}
          </span>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        {tiles.length > 0 ? (
          <dl className="grid gap-3 sm:grid-cols-3 xl:grid-cols-5">
            {tiles.map((tile) => (
              <div className="min-w-0 rounded-xl border border-hairline-gray bg-linen-white p-3" key={tile.label}>
                <dt className="mb-1 text-[12px] leading-4 text-charcoal">{tile.label}</dt>
                <dd className="m-0 text-[20px] font-semibold leading-7 text-forest-ink">{tile.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        {modeEntries.length > 0 ? (
          <div>
            <p className="mb-2 text-[12px] leading-4 text-charcoal">{copy.metricsModeDistribution}</p>
            <ul className="m-0 flex flex-wrap gap-2 p-0" aria-label={copy.metricsModeDistribution}>
              {modeEntries.map(({ mode, count }) => (
                <li
                  className="inline-flex items-center gap-2 rounded-full border border-hairline-gray bg-linen-white px-3 py-1 text-[12px] leading-4 text-charcoal shadow-sm"
                  key={mode}
                >
                  <span className="text-forest-ink">{executorModeLabel(normalizeExecutorMode(mode), mode, copy)}</span>
                  <span className="font-semibold text-cobalt-surface">{count}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

interface MetricTile {
  label: string;
  value: string;
}

function buildTiles(metrics: JobMetrics, copy: AdminCopy): MetricTile[] {
  const tiles: MetricTile[] = [];
  pushRate(tiles, copy.metricsSuccessRate, metrics.successRate);
  pushRate(tiles, copy.metricsMergeRate, metrics.mergeRate);
  pushRate(tiles, copy.metricsRetryRate, metrics.retryRate);
  pushRuntime(tiles, copy.metricsRuntimeP50, metrics.runtimeP50Ms);
  pushRuntime(tiles, copy.metricsRuntimeP95, metrics.runtimeP95Ms);
  return tiles;
}

function pushRate(tiles: MetricTile[], label: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  // Accept either a 0..1 fraction or an already-percentage 0..100 value defensively.
  const pct = value <= 1 ? value * 100 : value;
  tiles.push({ label, value: `${formatPercent(pct)}%` });
}

function pushRuntime(tiles: MetricTile[], label: string, ms: unknown): void {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return;
  tiles.push({ label, value: formatDuration(ms) });
}

function formatPercent(pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  // Whole numbers read cleaner; keep one decimal only when it carries information.
  return Number.isInteger(clamped) ? String(clamped) : clamped.toFixed(1);
}

function formatDuration(milliseconds: number): string {
  if (milliseconds <= 0) return "0s";
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function executorModeEntries(distribution: unknown): Array<{ mode: string; count: number }> {
  if (!distribution || typeof distribution !== "object") return [];
  return Object.entries(distribution as Record<string, unknown>)
    .filter(([mode, count]) => mode.length > 0 && typeof count === "number" && Number.isFinite(count) && count > 0)
    .map(([mode, count]) => ({ mode, count: count as number }))
    .sort((a, b) => b.count - a.count);
}
