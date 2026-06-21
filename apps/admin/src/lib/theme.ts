// Theme preference: light / dark / system. "system" follows the OS
// `prefers-color-scheme`. The choice is persisted to localStorage and applied as a
// `data-theme` attribute on <html>; the actual palette lives entirely in CSS
// variables (styles.css), so this module never touches colors — only the mode.

export type ThemePreference = "light" | "dark" | "system";

const THEME_STORAGE_KEY = "ADMIN_THEME";

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

export function getInitialTheme(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function storeTheme(theme: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage can be blocked in hardened browsers; the in-memory state still drives
    // the document attribute below so the toggle keeps working for the session.
  }
}

// Apply the preference to <html>. We always set an explicit attribute (including
// "system") so the CSS `prefers-color-scheme` rule — scoped to
// [data-theme="system"] and the unset default — knows an explicit light/dark
// choice should override the OS, while "system" defers to it.
export function applyTheme(theme: ThemePreference): void {
  try {
    document.documentElement.setAttribute("data-theme", theme);
  } catch {
    // No document (non-DOM env) — nothing to apply.
  }
}
