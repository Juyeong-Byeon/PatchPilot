// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMediaQuery } from "../src/lib/use-media-query.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

// jsdom ships no `matchMedia`; install a controllable fake exposing only the
// surface the hook uses (matches + add/removeEventListener("change", cb)).
function installMatchMedia(initialMatches: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    matches: initialMatches,
    addEventListener: (_type: string, cb: () => void) => {
      listeners.add(cb);
    },
    removeEventListener: (_type: string, cb: () => void) => {
      listeners.delete(cb);
    },
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn((_query: string) => mql),
  );
  return {
    set(next: boolean) {
      mql.matches = next;
      listeners.forEach((cb) => cb());
    },
    listenerCount: () => listeners.size,
  };
}

describe("useMediaQuery", () => {
  it("returns false when matchMedia is unavailable (jsdom default / SSR)", () => {
    const { result } = renderHook(() => useMediaQuery("(min-width: 768px)"));
    expect(result.current).toBe(false);
  });

  it("reflects the initial match and updates on change events", () => {
    const mm = installMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery("(min-width: 768px)"));
    expect(result.current).toBe(true);

    act(() => {
      mm.set(false);
    });
    expect(result.current).toBe(false);
  });

  it("unsubscribes its change listener on unmount", () => {
    const mm = installMatchMedia(false);
    const { unmount } = renderHook(() => useMediaQuery("(min-width: 768px)"));
    expect(mm.listenerCount()).toBe(1);

    unmount();
    expect(mm.listenerCount()).toBe(0);
  });
});
