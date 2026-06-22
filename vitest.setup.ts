// Test-only setup. React Query (≥5.80) defaults its notify scheduler to
// `setTimeout(cb, 0)`, so cache-change notifications flush on a macrotask. The
// admin tests settle queries with awaited microtasks (`await Promise.resolve()`),
// frequently under fake timers, where a macrotask flush never drains and a
// freshly resolved query would not re-render. Scheduling notifications on a
// microtask keeps React Query's batching while letting those awaited flush
// patterns observe a settled query in the same tick.
//
// This lives in test setup ONLY — production keeps React Query's default
// scheduler (verified behavior-equivalent: 401-freeze and interval polling are
// correct under the default). The line is a harmless no-op for non-React-Query
// suites (it only sets a global scheduler; no DOM is touched).
import { notifyManager } from "@tanstack/react-query";

notifyManager.setScheduler((flush) => queueMicrotask(flush));

if (typeof window !== "undefined") {
  const storage = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      clear: () => storage.clear(),
      getItem: (key: string) => storage.get(key) ?? null,
      removeItem: (key: string) => storage.delete(key),
      setItem: (key: string, value: string) => storage.set(key, String(value)),
    },
  });
}
