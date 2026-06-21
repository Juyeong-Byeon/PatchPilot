// Shared contract for the staged gstack runner's per-stage progress banner.
// The runner (producer) prints the banner to stdout; the worker (consumer)
// detects it and emits a structured `gstack.stage` run event. Keeping the
// format + parser in one place stops the producer and consumer from drifting.

export const GSTACK_STAGE_KEYS = ["plan", "implement", "review", "verify"] as const;
export type GstackStageKey = (typeof GSTACK_STAGE_KEYS)[number];

export interface GstackStageBanner {
  index: number;
  total: number;
  key: string;
}

const STAGE_BANNER = /=== gstack stage (\d+)\/(\d+): ([a-z]+) ===/;

export function formatStageBanner(index: number, total: number, key: string): string {
  return `=== gstack stage ${index}/${total}: ${key} ===`;
}

export function parseStageBanner(line: string): GstackStageBanner | null {
  const match = STAGE_BANNER.exec(line);
  if (!match) return null;
  const key = match[3];
  if (key === undefined) return null;
  return { index: Number(match[1]), total: Number(match[2]), key };
}
