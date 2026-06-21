// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { applyTheme, getInitialTheme, storeTheme } from "../src/lib/theme.js";

describe("theme preference", () => {
  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("defaults to system when nothing is stored", () => {
    expect(getInitialTheme()).toBe("system");
  });

  it("round-trips a stored preference", () => {
    storeTheme("dark");
    expect(getInitialTheme()).toBe("dark");
    storeTheme("light");
    expect(getInitialTheme()).toBe("light");
  });

  it("ignores a corrupt stored value", () => {
    window.localStorage.setItem("ADMIN_THEME", "neon");
    expect(getInitialTheme()).toBe("system");
  });

  it("applies the preference as a data-theme attribute, including system", () => {
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    // "system" is set explicitly so the CSS prefers-color-scheme rule (scoped to
    // [data-theme="system"]) can defer to the OS rather than an explicit choice.
    applyTheme("system");
    expect(document.documentElement.getAttribute("data-theme")).toBe("system");
  });
});
