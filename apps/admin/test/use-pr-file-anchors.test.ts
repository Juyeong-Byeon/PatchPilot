// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { usePrFileAnchors } from "../src/lib/use-pr-file-anchors.js";

// Independent reference for GitHub's `#diff-<sha256hex>` anchor (SHA-256 of the
// file path), computed via Node's crypto so the test cross-checks the hook's
// SubtleCrypto implementation rather than re-deriving it the same way.
const sha256hex = (value: string): string => createHash("sha256").update(value).digest("hex");

describe("usePrFileAnchors", () => {
  it("returns an empty map when disabled", () => {
    const { result } = renderHook(() => usePrFileAnchors(["src/app.ts"], false));
    expect(result.current).toEqual({});
  });

  it("returns an empty map when there are no paths", () => {
    const { result } = renderHook(() => usePrFileAnchors([], true));
    expect(result.current).toEqual({});
  });

  it("computes the SHA-256 hex anchor for each path", async () => {
    const paths = ["src/app.ts", "README.md", "packages/db/src/repositories.ts"];
    const { result } = renderHook(() => usePrFileAnchors(paths, true));

    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(paths.length));

    expect(result.current).toEqual({
      "src/app.ts": sha256hex("src/app.ts"),
      "README.md": sha256hex("README.md"),
      "packages/db/src/repositories.ts": sha256hex("packages/db/src/repositories.ts"),
    });
    // Anchors are 64-hex-char SHA-256 digests.
    for (const hex of Object.values(result.current)) {
      expect(hex).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("clears anchors when re-rendered as disabled", async () => {
    const { result, rerender } = renderHook(({ enabled }) => usePrFileAnchors(["src/app.ts"], enabled), {
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(result.current["src/app.ts"]).toBeDefined());

    rerender({ enabled: false });
    await waitFor(() => expect(result.current).toEqual({}));
  });
});
