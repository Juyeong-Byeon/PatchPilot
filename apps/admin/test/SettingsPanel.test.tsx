// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "../src/components/SettingsPanel.js";
import { adminCopy } from "../src/i18n.js";

const copy = adminCopy.ko;

function settingsResponse(overrideTimeout?: number) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({
      sections: [
        {
          key: "security",
          fields: [
            {
              key: "repositoryAllowlist",
              value: ["acme/web", "acme/api"],
              editable: false,
              kind: "csv",
              applies: "restart",
              source: "env",
            },
          ],
        },
        {
          key: "execution",
          fields: [
            {
              key: "jobTimeoutSeconds",
              value: overrideTimeout ?? 1800,
              editable: true,
              kind: "int",
              applies: "live",
              source: overrideTimeout ? "override" : "env",
              min: 60,
              max: 86400,
            },
            {
              key: "highPriorityStaged",
              value: true,
              editable: true,
              kind: "bool",
              applies: "live",
              source: "default",
            },
          ],
        },
      ],
    }),
    text: async () => "",
  } as Response;
}

function renderPanel() {
  return render(
    <SettingsPanel
      token="access-key"
      copy={copy}
      locale="ko"
      sessionExpired={false}
      onSessionExpired={() => undefined}
    />,
  );
}

describe("SettingsPanel", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders sections, read-only chips, and editable inputs", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(settingsResponse());
    renderPanel();

    await waitFor(() => expect(screen.getByLabelText("jobTimeoutSeconds")).toBeInTheDocument());

    // Read-only security value renders as chips, not an input.
    expect(screen.getByText("acme/web")).toBeInTheDocument();
    expect(screen.getByText("acme/api")).toBeInTheDocument();
    expect(screen.getByText(copy.settingsSecurityNote)).toBeInTheDocument();

    // Editable int field is a number input carrying the effective value.
    const timeout = screen.getByLabelText("jobTimeoutSeconds") as HTMLInputElement;
    expect(timeout.type).toBe("number");
    expect(timeout.value).toBe("1800");

    // Bool field is a checkbox.
    expect(screen.getByLabelText("highPriorityStaged")).toBeInTheDocument();
  });

  it("PUTs only changed values and shows success", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(settingsResponse())
      .mockResolvedValueOnce(settingsResponse(600));
    renderPanel();

    const timeout = (await screen.findByLabelText("jobTimeoutSeconds")) as HTMLInputElement;

    await act(async () => {
      fireEvent.change(timeout, { target: { value: "600" } });
    });
    await act(async () => {
      screen.getByRole("button", { name: copy.settingsSave }).click();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByText(copy.settingsSaved)).toBeInTheDocument());

    // The second call is the PUT with only the changed key.
    const putCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === "PUT");
    expect(putCall).toBeDefined();
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body).toEqual({ updates: { jobTimeoutSeconds: 600 } });
  });

  it("hides gracefully when the endpoint 404s (older backend)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => "",
      json: async () => ({}),
    } as Response);
    renderPanel();

    await waitFor(() => expect(screen.getByText(copy.settingsUnavailable)).toBeInTheDocument());
    // No editable inputs are rendered in the unavailable state.
    expect(screen.queryByLabelText("jobTimeoutSeconds")).not.toBeInTheDocument();
  });
});
