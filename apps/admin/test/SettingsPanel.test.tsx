// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

function renderPanel(overrides: Partial<Parameters<typeof SettingsPanel>[0]> = {}) {
  return render(
    <SettingsPanel
      token="access-key"
      copy={copy}
      locale="ko"
      sessionExpired={false}
      onSessionExpired={() => undefined}
      status={copy.ready}
      listError=""
      editingToken={false}
      onEditingTokenChange={() => undefined}
      onTokenChange={() => undefined}
      onSaveToken={() => undefined}
      onRefresh={() => undefined}
      onChangeLocale={() => undefined}
      {...overrides}
    />,
  );
}

describe("SettingsPanel", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the 계정·인증 and 언어 preference sections", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(settingsResponse());
    renderPanel();

    // Preference group renders immediately from client state.
    expect(screen.getByRole("region", { name: copy.settingsAccountSection })).toBeInTheDocument();
    expect(screen.getByText(copy.tokenAuthenticated)).toBeInTheDocument();
    const languageRegion = screen.getByRole("region", { name: copy.settingsLanguageSection });
    expect(within(languageRegion).getByRole("button", { name: "한국어" })).toBeInTheDocument();
    expect(within(languageRegion).getByRole("button", { name: "English" })).toBeInTheDocument();
  });

  it("renders the preference sections even when the config endpoint 404s", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => "",
      json: async () => ({}),
    } as Response);
    renderPanel();

    // Config groups degrade to the unavailable note...
    await waitFor(() => expect(screen.getByText(copy.settingsUnavailable)).toBeInTheDocument());
    // ...but the pure client-state preference sections still render.
    expect(screen.getByRole("region", { name: copy.settingsAccountSection })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: copy.settingsLanguageSection })).toBeInTheDocument();
    // System group (read-only config) is hidden entirely when unavailable.
    expect(screen.queryByRole("button", { name: copy.settingsSystemShow })).not.toBeInTheDocument();
  });

  it("reveals the access-key input when 수정 is clicked (relocated edit stage)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(settingsResponse());
    const onEditingTokenChange = vi.fn();
    const { rerender } = renderPanel({ onEditingTokenChange });

    // Default stage: 인증됨 indicator, no input.
    expect(screen.getByText(copy.tokenAuthenticated)).toBeInTheDocument();
    expect(screen.queryByLabelText(copy.tokenLabel)).not.toBeInTheDocument();

    // Clicking 수정 asks App to enter the edit stage.
    await act(async () => {
      screen.getByRole("button", { name: /수정/ }).click();
      await Promise.resolve();
    });
    expect(onEditingTokenChange).toHaveBeenCalledWith(true);

    // App flips editingToken back in; the input now renders.
    rerender(
      <SettingsPanel
        token="access-key"
        copy={copy}
        locale="ko"
        sessionExpired={false}
        onSessionExpired={() => undefined}
        status={copy.ready}
        listError=""
        editingToken
        onEditingTokenChange={onEditingTokenChange}
        onTokenChange={() => undefined}
        onSaveToken={() => undefined}
        onRefresh={() => undefined}
        onChangeLocale={() => undefined}
      />,
    );
    expect(screen.getByLabelText(copy.tokenLabel)).toBeInTheDocument();
  });

  it("collapses the 시스템 정보 group by default and expands it on click", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(settingsResponse());
    renderPanel();

    // Editable section is visible up front; read-only section is hidden until expanded.
    await waitFor(() => expect(screen.getByLabelText("jobTimeoutSeconds")).toBeInTheDocument());
    const toggle = screen.getByRole("button", { name: copy.settingsSystemShow });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("acme/web")).not.toBeInTheDocument();
    expect(screen.queryByText(copy.settingsSecurityNote)).not.toBeInTheDocument();

    // Expanding reveals the read-only security section, chips, and the note.
    await act(async () => {
      toggle.click();
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: copy.settingsSystemHide })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("acme/web")).toBeInTheDocument();
    expect(screen.getByText("acme/api")).toBeInTheDocument();
    expect(screen.getByText(copy.settingsSecurityNote)).toBeInTheDocument();
  });

  it("renders editable inputs in the 운영 설정 group", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(settingsResponse());
    renderPanel();

    await waitFor(() => expect(screen.getByLabelText("jobTimeoutSeconds")).toBeInTheDocument());

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

  it("changes the locale from the 언어 section", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(settingsResponse());
    const onChangeLocale = vi.fn();
    renderPanel({ onChangeLocale });

    const languageRegion = screen.getByRole("region", { name: copy.settingsLanguageSection });
    await act(async () => {
      within(languageRegion).getByRole("button", { name: "English" }).click();
      await Promise.resolve();
    });
    expect(onChangeLocale).toHaveBeenCalledWith("en");
  });

  it("exposes loading semantics to assistive tech while the config fetch is pending", async () => {
    // A fetch that never resolves keeps the panel in the loading state so we can
    // assert the additive a11y cues on the loading→loaded swap.
    vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise<Response>(() => {}));
    renderPanel();

    // The Operations group container is marked busy while config loads...
    const operations = screen.getByRole("region", { name: copy.settingsGroupOperations });
    expect(operations).toHaveAttribute("aria-busy", "true");

    // ...and the loading text is a polite live region so the transition is announced.
    const loading = screen.getByText(copy.settingsLoading);
    expect(loading).toHaveAttribute("aria-live", "polite");
  });

  it("degrades the config groups gracefully when the endpoint 404s (older backend)", async () => {
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
