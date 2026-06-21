import { useEffect, useState } from "react";

// GitHub anchors each file in a PR's "Files changed" tab as `#diff-<sha256hex>`
// where the hash is the SHA-256 of the file path. Computing it needs SubtleCrypto
// (async, HTTPS/localhost only), so we resolve the anchors in an effect and expose
// a path → hex map. Until a path resolves (or if SubtleCrypto is unavailable) its
// entry is simply absent and the caller links to the Files tab without an anchor.
export function usePrFileAnchors(paths: readonly string[], enabled: boolean): Record<string, string> {
  const [anchors, setAnchors] = useState<Record<string, string>>({});
  // Stable dependency key so the effect only re-runs when the path set changes.
  const key = enabled ? paths.join("\n") : "";

  useEffect(() => {
    if (!enabled || paths.length === 0) {
      setAnchors({});
      return;
    }
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
      setAnchors({});
      return;
    }

    let cancelled = false;
    void Promise.all(
      paths.map(async (path) => {
        try {
          const bytes = new TextEncoder().encode(path);
          const digest = await subtle.digest("SHA-256", bytes);
          const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
          return [path, hex] as const;
        } catch {
          return [path, ""] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const next: Record<string, string> = {};
      for (const [path, hex] of entries) if (hex) next[path] = hex;
      setAnchors(next);
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  return anchors;
}
