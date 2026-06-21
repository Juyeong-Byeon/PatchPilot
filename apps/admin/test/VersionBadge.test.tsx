// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VersionBadge } from "../src/components/VersionBadge.js";
import { adminCopy } from "../src/i18n.js";

describe("VersionBadge", () => {
  afterEach(() => cleanup());

  it("renders the version and the short (7-char) sha with a separator", () => {
    render(<VersionBadge copy={adminCopy.ko} version={{ version: "0.1.0", sha: "1a2b3c4d5e6f7g8" }} />);

    const badge = screen.getByLabelText(adminCopy.ko.versionLabel);
    expect(badge).toBeInTheDocument();
    // Version is prefixed with "v"; the sha is truncated to its first 7 characters and
    // joined with a middot separator.
    expect(badge).toHaveTextContent("v0.1.0 · 1a2b3c4");
    // The trailing characters of the full sha must not leak in.
    expect(badge).not.toHaveTextContent("5e6f7g8");
  });

  it("renders the version only, with no trailing separator, when the sha is null", () => {
    render(<VersionBadge copy={adminCopy.ko} version={{ version: "0.1.0", sha: null }} />);

    const badge = screen.getByLabelText(adminCopy.ko.versionLabel);
    expect(badge).toHaveTextContent("v0.1.0");
    // No middot separator when there is no sha to show.
    expect(badge.textContent).toBe("v0.1.0");
  });

  it("exposes an accessible label so the stamp is identifiable to assistive tech", () => {
    render(<VersionBadge copy={adminCopy.en} version={{ version: "2.3.4", sha: "abcdef0" }} />);

    expect(screen.getByLabelText(adminCopy.en.versionLabel)).toBeInTheDocument();
  });

  it("renders nothing while the version is unavailable (loading / failed fetch)", () => {
    const { container } = render(<VersionBadge copy={adminCopy.ko} version={null} />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByLabelText(adminCopy.ko.versionLabel)).not.toBeInTheDocument();
  });
});
