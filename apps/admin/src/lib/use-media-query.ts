import { useEffect, useState } from "react";

/**
 * Subscribe to a CSS media query. Returns whether it currently matches.
 *
 * Used to mount exactly one of the job list's two layouts (wide table vs stacked
 * cards) instead of rendering both and toggling with CSS `hidden`. Rendering both
 * would duplicate every row in the DOM and the accessibility tree; mounting one
 * keeps the a11y tree clean and avoids doubled work.
 *
 * SSR/test-safe: when `matchMedia` is unavailable (e.g. jsdom without a polyfill)
 * it resolves to `false`, so the caller falls back to its default (desktop) layout.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => readMatch(query));

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

function readMatch(query: string): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(query).matches;
}
