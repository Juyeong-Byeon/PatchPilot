import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Pencil, ShieldCheck } from "lucide-react";
import {
  fetchSettings,
  SETTINGS_UNAVAILABLE,
  updateSettings,
  type SettingsFieldView,
  type SettingsSectionView,
  type SettingsView,
} from "../api.js";
import { localeNames, settingsFieldLabel, settingsSectionLabel, type AdminCopy, type Locale } from "../i18n.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.js";
import { Input } from "./ui/input.js";
import { Select } from "./ui/select.js";

interface SettingsPanelProps {
  token: string;
  copy: AdminCopy;
  locale: Locale;
  sessionExpired: boolean;
  onSessionExpired(): void;
  // Account/auth controls relocated from the sidebar. The token edit stage lives
  // here now; App owns the token + edit-stage state and the save/refresh actions.
  status: string;
  listError: string;
  editingToken: boolean;
  onEditingTokenChange(next: boolean): void;
  onTokenChange(next: string): void;
  onSaveToken(): void;
  onRefresh(): void;
  // Locale control relocated from the sidebar (theme stays on the sidebar).
  onChangeLocale(next: Locale): void;
}

// A pending edit for an editable field, keyed by setting key. Values are the typed
// form (number/boolean/string) that the PUT body carries.
type EditState = Record<string, unknown>;

/**
 * Settings page. Organized into three groups with progressive disclosure so the
 * page opens calm:
 *   1. 환경설정 (Preferences) — 계정·인증 + 언어. Pure client state; renders even when
 *      the config endpoint is unavailable.
 *   2. 운영 설정 (Operations) — editable config sections, open by default.
 *   3. 시스템 정보 (System) — read-only config sections, collapsed by default.
 *
 * Defensive: GET /api/settings is shipped by this track and may not exist on an
 * older backend, so a 404 (SETTINGS_UNAVAILABLE) degrades the config groups to a
 * quiet note while the preference group still renders. 401 defers to the app-wide
 * re-auth boundary.
 */
export function SettingsPanel({
  token,
  copy,
  locale,
  sessionExpired,
  onSessionExpired,
  status,
  listError,
  editingToken,
  onEditingTokenChange,
  onTokenChange,
  onSaveToken,
  onRefresh,
  onChangeLocale,
}: SettingsPanelProps) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [edits, setEdits] = useState<EditState>({});
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState("");

  const onSessionExpiredRef = useRef(onSessionExpired);
  onSessionExpiredRef.current = onSessionExpired;

  useEffect(() => {
    if (!token.trim() || sessionExpired) {
      setView(null);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    void fetchSettings(token)
      .then((data) => {
        if (cancelled) return;
        setView(data);
        setUnavailable(false);
        setEdits({});
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        if (caught instanceof Error && caught.message === "admin_access_key_invalid") {
          onSessionExpiredRef.current();
          return;
        }
        if (caught instanceof Error && caught.message === SETTINGS_UNAVAILABLE) {
          setUnavailable(true);
          setView(null);
          return;
        }
        setError(caught instanceof Error ? caught.message : "Unknown error");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, sessionExpired]);

  // The pending edits that actually differ from the current effective value, in the
  // typed form the PUT body expects. Drives the Save button's disabled state and the
  // request payload.
  const changedUpdates = useMemo(() => buildChangedUpdates(view, edits), [view, edits]);
  const hasChanges = Object.keys(changedUpdates).length > 0;

  // Split config sections into editable (운영 설정) vs read-only (시스템 정보). A section
  // joins Operations if it carries any editable field; everything else is System.
  const { editableSections, readOnlySections } = useMemo(() => partitionSections(view), [view]);

  function setFieldEdit(key: string, value: unknown) {
    setSaveState("idle");
    setEdits((prev) => ({ ...prev, [key]: value }));
  }

  async function save() {
    if (!hasChanges) return;
    setSaveState("saving");
    setError("");
    try {
      const next = await updateSettings(changedUpdates, token);
      setView(next);
      setEdits({});
      setSaveState("saved");
    } catch (caught) {
      if (caught instanceof Error && caught.message === "admin_access_key_invalid") {
        onSessionExpiredRef.current();
        return;
      }
      setSaveState("idle");
      setError(caught instanceof Error ? caught.message : copy.settingsSaveFailed);
    }
  }

  const hasSecurity = readOnlySections.some((section) => section.key === "security");

  return (
    <div className="grid gap-8">
      {/* 환경설정 — pure client state; always rendered, even when config is unavailable. */}
      <SettingsGroup
        title={copy.settingsGroupPreferences}
        hint={copy.settingsGroupPreferencesHint}
        ariaLabel={copy.settingsGroupPreferences}
      >
        <AccountSection
          copy={copy}
          status={status}
          listError={listError}
          editingToken={editingToken}
          token={token}
          sessionExpired={sessionExpired}
          onEditingTokenChange={onEditingTokenChange}
          onTokenChange={onTokenChange}
          onSaveToken={onSaveToken}
          onRefresh={onRefresh}
        />
        <LanguageSection copy={copy} locale={locale} onChangeLocale={onChangeLocale} />
      </SettingsGroup>

      {/* 운영 설정 — editable config, open by default. Degrades to a note on 404. */}
      <SettingsGroup
        title={copy.settingsGroupOperations}
        hint={copy.settingsGroupOperationsHint}
        ariaLabel={copy.settingsGroupOperations}
      >
        {unavailable ? (
          <Card>
            <CardContent>
              <p className="m-0 text-[13px] leading-5 text-charcoal">{copy.settingsUnavailable}</p>
            </CardContent>
          </Card>
        ) : isLoading && !view ? (
          <p className="text-[13px] text-charcoal">{copy.settingsLoading}</p>
        ) : (
          <>
            {editableSections.map((section) => (
              <SettingsSectionCard
                key={section.key}
                section={section}
                edits={edits}
                copy={copy}
                locale={locale}
                onEdit={setFieldEdit}
              />
            ))}

            {view ? (
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" onClick={() => void save()} disabled={!hasChanges || saveState === "saving"}>
                  {saveState === "saving" ? copy.settingsSaving : copy.settingsSave}
                </Button>
                {saveState === "saved" ? (
                  <span role="status" className="text-[13px] font-medium text-cobalt-surface">
                    {copy.settingsSaved}
                  </span>
                ) : null}
                {!hasChanges && saveState === "idle" ? (
                  <span className="text-[12px] text-charcoal">{copy.settingsNoChanges}</span>
                ) : null}
                {error ? (
                  <strong role="alert" className="text-[12px] font-normal leading-4 text-danger">
                    {error}
                  </strong>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </SettingsGroup>

      {/* 시스템 정보 — read-only config, collapsed by default. Hidden entirely on 404. */}
      {!unavailable && readOnlySections.length > 0 ? (
        <SystemInfoGroup sections={readOnlySections} copy={copy} locale={locale} showSecurityNote={hasSecurity} />
      ) : null}
    </div>
  );
}

// Group header (label + hint) shared by every Settings group.
function SettingsGroup({
  title,
  hint,
  ariaLabel,
  children,
}: {
  title: string;
  hint: string;
  ariaLabel: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-4" aria-label={ariaLabel}>
      <div>
        <h2 className="text-[15px] font-semibold uppercase tracking-[0.08em] text-cobalt-surface">{title}</h2>
        <p className="mt-1 text-[12px] leading-4 text-charcoal">{hint}</p>
      </div>
      {children}
    </section>
  );
}

// 계정 · 인증: relocated admin-key management. Mirrors the old sidebar edit stage —
// 인증됨 indicator + masked key, 수정 to reveal the input, 새로고침 to re-pull jobs.
function AccountSection({
  copy,
  status,
  listError,
  editingToken,
  token,
  sessionExpired,
  onEditingTokenChange,
  onTokenChange,
  onSaveToken,
  onRefresh,
}: {
  copy: AdminCopy;
  status: string;
  listError: string;
  editingToken: boolean;
  token: string;
  sessionExpired: boolean;
  onEditingTokenChange(next: boolean): void;
  onTokenChange(next: string): void;
  onSaveToken(): void;
  onRefresh(): void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <Card aria-label={copy.settingsAccountSection}>
      <CardHeader>
        <CardTitle>{copy.settingsAccountSection}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="m-0 text-[12px] leading-4 text-charcoal">{copy.settingsAccountHint}</p>
        {editingToken ? (
          // Edit stage: reveal the access-key input with 적용 / 취소 controls.
          <form
            className="grid max-w-[420px] gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              onSaveToken();
            }}
          >
            <label className="sr-only" htmlFor="admin-token">
              {copy.tokenLabel}
            </label>
            <Input
              id="admin-token"
              ref={inputRef}
              value={token}
              type="password"
              autoComplete="off"
              placeholder={copy.tokenPlaceholder}
              aria-invalid={sessionExpired || undefined}
              onChange={(event) => onTokenChange(event.target.value)}
            />
            <div className="flex gap-2">
              <Button type="submit">{copy.apply}</Button>
              <Button type="button" variant="outline" onClick={() => onEditingTokenChange(false)}>
                {copy.tokenCancel}
              </Button>
            </div>
          </form>
        ) : (
          // Default stage: compact authenticated indicator + 수정 / 새로고침.
          <div className="grid max-w-[420px] gap-2">
            <div className="inline-flex items-center gap-2 rounded-lg border border-electric-blue/20 bg-mist-blue px-2.5 py-1.5 text-cobalt-surface">
              <ShieldCheck aria-hidden="true" size={16} strokeWidth={2.2} />
              <span className="text-[12px] font-semibold leading-4">{copy.tokenAuthenticated}</span>
              <span className="ml-auto font-mono text-[12px] leading-4 tracking-[0.2em] text-charcoal">••••••••</span>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  onEditingTokenChange(true);
                  window.setTimeout(() => inputRef.current?.focus(), 0);
                }}
              >
                <Pencil data-icon aria-hidden="true" strokeWidth={2.2} />
                {copy.tokenEdit}
              </Button>
              <Button type="button" variant="outline" onClick={onRefresh}>
                {copy.refresh}
              </Button>
            </div>
          </div>
        )}
        <div>
          <span className="block text-[12px] leading-4 text-charcoal" aria-live="polite">
            {status}
          </span>
          {listError ? (
            <strong
              role="alert"
              className="mt-2 block rounded-lg bg-danger px-2.5 py-1.5 text-xs font-normal leading-4 text-white"
            >
              {listError}
            </strong>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

// 언어: relocated locale ko/en control. Theme stays on the sidebar.
function LanguageSection({
  copy,
  locale,
  onChangeLocale,
}: {
  copy: AdminCopy;
  locale: Locale;
  onChangeLocale(next: Locale): void;
}) {
  return (
    <Card aria-label={copy.settingsLanguageSection}>
      <CardHeader>
        <CardTitle>{copy.settingsLanguageSection}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="m-0 text-[12px] leading-4 text-charcoal">{copy.settingsLanguageHint}</p>
        <div
          className="flex max-w-[280px] items-center gap-1 rounded-lg bg-mist-blue p-1"
          role="group"
          aria-label={copy.settingsLanguageSection}
        >
          {(["ko", "en"] as Locale[]).map((entry) => (
            <Button
              key={entry}
              type="button"
              size="sm"
              variant={locale === entry ? "default" : "ghost"}
              className="h-8 flex-1"
              aria-pressed={locale === entry}
              onClick={() => onChangeLocale(entry)}
            >
              {localeNames[entry]}
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// 시스템 정보: read-only config sections behind one expandable disclosure so the page
// opens calm. Collapsed by default; the operator expands only when needed.
function SystemInfoGroup({
  sections,
  copy,
  locale,
  showSecurityNote,
}: {
  sections: SettingsSectionView[];
  copy: AdminCopy;
  locale: Locale;
  showSecurityNote: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <section className="grid gap-4" aria-label={copy.settingsGroupSystem}>
      <div>
        <h2 className="text-[15px] font-semibold uppercase tracking-[0.08em] text-cobalt-surface">
          {copy.settingsGroupSystem}
        </h2>
        <p className="mt-1 text-[12px] leading-4 text-charcoal">{copy.settingsGroupSystemHint}</p>
      </div>

      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="interactive-card inline-flex h-10 w-full items-center gap-2 rounded-xl border border-hairline-gray bg-linen-white px-3 text-left text-[13px] font-semibold text-forest-ink"
      >
        {open ? (
          <ChevronDown aria-hidden="true" size={16} className="shrink-0 text-graphite" strokeWidth={2.2} />
        ) : (
          <ChevronRight aria-hidden="true" size={16} className="shrink-0 text-graphite" strokeWidth={2.2} />
        )}
        {open ? copy.settingsSystemHide : copy.settingsSystemShow}
      </button>

      {open ? (
        <div className="grid gap-4">
          {showSecurityNote ? (
            <p
              role="note"
              className="m-0 rounded-xl border border-amber-border bg-amber-wash px-3 py-2 text-[12px] leading-5 text-amber-ink"
            >
              {copy.settingsSecurityNote}
            </p>
          ) : null}
          {sections.map((section) => (
            <SettingsSectionCard key={section.key} section={section} edits={{}} copy={copy} locale={locale} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function SettingsSectionCard({
  section,
  edits,
  copy,
  locale,
  onEdit,
}: {
  section: SettingsSectionView;
  edits: EditState;
  copy: AdminCopy;
  locale: Locale;
  onEdit?: (key: string, value: unknown) => void;
}) {
  return (
    <Card aria-label={settingsSectionLabel(section.key, locale)}>
      <CardHeader>
        <CardTitle>{settingsSectionLabel(section.key, locale)}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {section.fields.map((field) => (
          <SettingRow key={field.key} field={field} edits={edits} copy={copy} locale={locale} onEdit={onEdit} />
        ))}
      </CardContent>
    </Card>
  );
}

function SettingRow({
  field,
  edits,
  copy,
  locale,
  onEdit,
}: {
  field: SettingsFieldView;
  edits: EditState;
  copy: AdminCopy;
  locale: Locale;
  onEdit?: ((key: string, value: unknown) => void) | undefined;
}) {
  const label = settingsFieldLabel(field.key, locale);
  const editedValue = field.key in edits ? edits[field.key] : field.value;

  return (
    <div className="grid gap-2 border-b border-hairline-gray pb-4 last:border-b-0 last:pb-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] md:items-start md:gap-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <strong className="text-[13px] font-semibold text-forest-ink">{label}</strong>
          {field.editable ? (
            field.applies === "restart" ? (
              <Badge variant="warning">{copy.settingsAppliesRestart}</Badge>
            ) : (
              <Badge variant="outline">{copy.settingsAppliesLive}</Badge>
            )
          ) : (
            <Badge variant="outline">{copy.settingsReadOnly}</Badge>
          )}
        </div>
        <span className="mt-1 block font-mono text-[11px] leading-4 text-charcoal">
          {field.key} · {sourceLabel(field.source, copy)}
        </span>
      </div>
      <div className="min-w-0">
        {field.editable && onEdit ? (
          <EditableControl field={field} value={editedValue} copy={copy} onEdit={onEdit} />
        ) : (
          <ReadonlyValue field={field} copy={copy} />
        )}
      </div>
    </div>
  );
}

function EditableControl({
  field,
  value,
  copy,
  onEdit,
}: {
  field: SettingsFieldView;
  value: unknown;
  copy: AdminCopy;
  onEdit(key: string, value: unknown): void;
}) {
  if (field.kind === "bool") {
    const checked = value === true;
    return (
      <label className="inline-flex items-center gap-2">
        <input
          type="checkbox"
          checked={checked}
          aria-label={field.key}
          onChange={(event) => onEdit(field.key, event.target.checked)}
          className="size-4"
        />
        <span className="text-[13px] text-true-black">{checked ? copy.settingsBoolYes : copy.settingsBoolNo}</span>
      </label>
    );
  }
  if (field.kind === "enum") {
    return (
      <Select
        aria-label={field.key}
        value={String(value ?? "")}
        onChange={(event) => onEdit(field.key, event.target.value)}
      >
        {(field.enumValues ?? []).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </Select>
    );
  }
  if (field.kind === "int") {
    return (
      <Input
        type="number"
        aria-label={field.key}
        value={value === undefined || value === null ? "" : String(value)}
        min={field.min}
        max={field.max}
        onChange={(event) => {
          const raw = event.target.value;
          onEdit(field.key, raw === "" ? "" : Number(raw));
        }}
        className="w-full max-w-[220px]"
      />
    );
  }
  // string / csv editable (none editable today, but keep the control complete).
  return (
    <Input
      type="text"
      aria-label={field.key}
      value={typeof value === "string" ? value : Array.isArray(value) ? value.join(", ") : ""}
      onChange={(event) => onEdit(field.key, event.target.value)}
      className="w-full"
    />
  );
}

function ReadonlyValue({ field, copy }: { field: SettingsFieldView; copy: AdminCopy }) {
  if (field.kind === "bool") {
    return (
      <span className="text-[13px] text-true-black">
        {field.value === true ? copy.settingsBoolYes : copy.settingsBoolNo}
      </span>
    );
  }
  if (field.kind === "csv") {
    const items = Array.isArray(field.value) ? field.value.map((item) => String(item)) : [];
    if (items.length === 0) return <span className="text-[13px] text-charcoal">{copy.settingsEmptyList}</span>;
    return (
      <ul className="m-0 flex flex-wrap gap-1.5 p-0">
        {items.map((item) => (
          <li key={item}>
            <Badge variant="outline" className="font-mono text-[11px]">
              {item}
            </Badge>
          </li>
        ))}
      </ul>
    );
  }
  const text =
    field.value === null || field.value === undefined || field.value === "" ? copy.empty : String(field.value);
  return <span className="break-all font-mono text-[12px] text-true-black">{text}</span>;
}

function sourceLabel(source: SettingsFieldView["source"], copy: AdminCopy): string {
  switch (source) {
    case "override":
      return copy.settingsSourceOverride;
    case "env":
      return copy.settingsSourceEnv;
    default:
      return copy.settingsSourceDefault;
  }
}

/**
 * Split the effective config into editable sections (운영 설정) and read-only sections
 * (시스템 정보). A section is editable if any of its fields can be changed; this keys
 * off the data rather than hard-coded section names so a future editable setting
 * lands in the right group automatically.
 */
function partitionSections(view: SettingsView | null): {
  editableSections: SettingsSectionView[];
  readOnlySections: SettingsSectionView[];
} {
  const editableSections: SettingsSectionView[] = [];
  const readOnlySections: SettingsSectionView[] = [];
  for (const section of view?.sections ?? []) {
    if (section.fields.some((field) => field.editable)) editableSections.push(section);
    else readOnlySections.push(section);
  }
  return { editableSections, readOnlySections };
}

/**
 * Compute the subset of pending edits that differ from the current effective value,
 * normalized to the typed form the PUT body expects. An int field with an empty
 * string (cleared input) is treated as "no change" so a blank field never sends a
 * bad value.
 */
function buildChangedUpdates(view: SettingsView | null, edits: EditState): Record<string, unknown> {
  if (!view) return {};
  const fieldByKey = new Map<string, SettingsFieldView>();
  for (const section of view.sections) {
    for (const field of section.fields) fieldByKey.set(field.key, field);
  }

  const updates: Record<string, unknown> = {};
  for (const [key, edited] of Object.entries(edits)) {
    const field = fieldByKey.get(key);
    if (!field || !field.editable) continue;
    if (field.kind === "int") {
      if (edited === "" || edited === undefined || edited === null) continue;
      const num = Number(edited);
      if (!Number.isFinite(num)) continue;
      if (num !== field.value) updates[key] = num;
      continue;
    }
    if (edited !== field.value) updates[key] = edited;
  }
  return updates;
}
