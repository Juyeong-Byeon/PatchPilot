// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "../src/App.js";

describe("App", () => {
  it("renders operations console", () => {
    render(<App />);

    expect(screen.getByText("티켓-PR 운영")).toBeInTheDocument();
  });
});
