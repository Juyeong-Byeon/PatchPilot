// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "../src/App.js";

describe("App", () => {
  it("renders operations console", () => {
    render(<App />);

    expect(screen.getAllByText("티켓-PR 운영").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { level: 1, name: "작업" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "작업" })).toBeInTheDocument();
    expect(screen.getByLabelText("관리자 인증키")).toBeInTheDocument();
  });
});
