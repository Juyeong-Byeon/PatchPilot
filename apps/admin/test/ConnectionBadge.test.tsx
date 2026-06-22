// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectionBadge } from "../src/components/ConnectionBadge.js";
import { adminCopy } from "../src/i18n.js";

describe("ConnectionBadge", () => {
  afterEach(() => cleanup());

  it("shows the local frontend, API target, request path, runtime, and build", () => {
    render(
      <ConnectionBadge
        copy={adminCopy.ko}
        frontendOrigin="http://localhost:5173"
        apiDisplayUrl="http://localhost:3000"
        requestMode="proxy"
        version={{
          version: "0.1.0",
          sha: "abcdef0123456789",
          nodeEnv: "development",
          executorMode: "mock",
          publisherMode: "mock",
        }}
      />,
    );

    const badge = screen.getByLabelText(adminCopy.ko.connectionLabel);
    expect(within(badge).getByText("http://localhost:5173")).toBeInTheDocument();
    expect(within(badge).getByText("http://localhost:3000")).toBeInTheDocument();
    expect(within(badge).getByText(adminCopy.ko.connectionProxy)).toBeInTheDocument();
    expect(within(badge).getByText("development · mock/mock")).toBeInTheDocument();
    expect(within(badge).getByText("v0.1.0 · abcdef0")).toBeInTheDocument();
  });
});
