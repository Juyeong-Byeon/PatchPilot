import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchSettings,
  SETTINGS_UNAVAILABLE,
  updateSettings,
  type SettingsFieldView,
  type SettingsSectionView,
  type SettingsView,
} from "../api.js";
import { settingsFieldLabel, settingsSectionLabel, type AdminCopy, type Locale } from "../i18n.js";
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
}

// A pending edit for an editable field, keyed by setting key. Values are the typed
// form (number/boolean/string) that the PUT body carries.
type EditState = Record<string, unknown>;

/**
 * Settings page (read-only effective config + editable safe operational values).
 * Defensive: GET /api/settings is shipped by this track and may not exist on an
 * older backend, so a 404 (SETTINGS_UNAVAILABLE) renders an unobtrusive note instead
 * of a broken screen. 401 defers to the app-wide re-auth boundary.
 */
export function SettingsPanel({ token, copy, locale, sessionExpired, onSessionExpired }: SettingsPanelProps) {
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

  // Older backend without the endpoint: show a quiet note rather than a broken page.
  if (unavailable) {
    return (
      <Card aria-label={copy.settings}>
        <CardHeader>
          <CardTitle>{copy.settings}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="m-0 text-[13px] leading-5 text-charcoal">{copy.settingsUnavailable}</p>
        </CardContent>
      </Card>
    );
  }

  const hasSecurity = (view?.sections ?? []).some((section) => section.key === "security");

  return (
    <div className="grid gap-4">
      {hasSecurity ? (
        <p
          role="note"
          className="m-0 rounded-xl border border-amber-border bg-amber-wash px-3 py-2 text-[12px] leading-5 text-amber-ink"
        >
          {copy.settingsSecurityNote}
        </p>
      ) : null}

      {isLoading && !view ? <p className="text-[13px] text-charcoal">{copy.settingsLoading}</p> : null}

      {(view?.sections ?? []).map((section) => (
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
    </div>
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
  onEdit(key: string, value: unknown): void;
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
  onEdit(key: string, value: unknown): void;
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
        {field.editable ? (
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
