import {
  EDITABLE_KEYS,
  SETTINGS_FIELDS,
  SettingValidationError,
  getSettingField,
  parseSettingValue,
  resolveEffectiveSettings,
  validateSettingValue,
  type SettingField,
  type SettingSection,
} from "@ticket-to-pr/core";
import type { FastifyInstance } from "fastify";
import { assertAdminToken } from "./auth.js";

/**
 * Repository surface the settings routes need. Kept narrow (and optional on the
 * server deps) so an older backend without these methods simply does not register
 * the routes — the admin then sees a graceful 404.
 */
export interface SettingsRepositories {
  getAppSettings(): Promise<Record<string, unknown>>;
  setAppSettings(updates: Record<string, unknown>, actor: string): Promise<void>;
  appendAuditEvent(input: {
    actor: string;
    action: string;
    jobId?: string;
    runId?: string;
    metadata?: unknown;
  }): Promise<void>;
}

/** One field as rendered to the admin. Secret fields never reach this shape. */
export interface SettingsFieldView {
  key: string;
  value: unknown;
  editable: boolean;
  kind: SettingField["kind"];
  applies: SettingField["applies"];
  source: "override" | "env" | "default";
  enumValues?: readonly string[];
  min?: number;
  max?: number;
}

export interface SettingsSectionView {
  key: SettingSection;
  fields: SettingsFieldView[];
}

export interface SettingsView {
  sections: SettingsSectionView[];
}

const SECTION_ORDER: readonly SettingSection[] = [
  "modes",
  "security",
  "execution",
  "lifecycle",
  "integration",
  "runtime",
];

/**
 * Build the display-safe effective settings view: resolve env ⊕ override for every
 * non-secret field, then group by section. Secret fields are already excluded by
 * resolveEffectiveSettings, so nothing secret can leak here.
 */
export function buildSettingsView(
  envSource: Record<string, string | undefined>,
  overrides: Record<string, unknown>,
): SettingsView {
  const resolved = resolveEffectiveSettings(envSource, overrides);
  const sections: SettingsSectionView[] = SECTION_ORDER.map((section) => ({ key: section, fields: [] }));
  const sectionByKey = new Map(sections.map((s) => [s.key, s]));

  for (const field of SETTINGS_FIELDS) {
    const entry = resolved[field.key];
    if (!entry) continue; // secret field — omitted
    const view: SettingsFieldView = {
      key: field.key,
      value: entry.value,
      editable: field.editable,
      kind: field.kind,
      applies: field.applies,
      source: entry.source,
    };
    if (field.enumValues) view.enumValues = field.enumValues;
    if (field.min !== undefined) view.min = field.min;
    if (field.max !== undefined) view.max = field.max;
    sectionByKey.get(field.section)?.fields.push(view);
  }

  // Drop empty sections (e.g. integration when no Lark mapping fields resolve) so the
  // admin never renders a blank card.
  return { sections: sections.filter((section) => section.fields.length > 0) };
}

export async function registerSettingsRoutes(
  app: FastifyInstance,
  repos: SettingsRepositories,
  adminToken: string,
): Promise<void> {
  app.addHook("preHandler", async (request) => {
    const path = request.url.split("?", 1)[0] ?? "";
    if (path.startsWith("/api/settings")) {
      assertAdminToken(request, adminToken);
    }
  });

  app.get("/api/settings", async () => {
    const overrides = await repos.getAppSettings();
    return buildSettingsView(process.env, overrides);
  });

  app.put<{ Body: { updates?: Record<string, unknown> } }>("/api/settings", async (request, reply) => {
    const updates = request.body?.updates;
    if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
      return reply.code(400).send({ error: "Body must be { updates: Record<string, unknown> }" });
    }

    // Validate the whole batch up front so a single bad key/value rejects the entire
    // write — no partial save. Reject non-editable keys (read-only / unknown) with 400.
    const validated: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(updates)) {
      if (!EDITABLE_KEYS.includes(key)) {
        return reply.code(400).send({ error: `Setting is not editable: ${key}` });
      }
      const field = getSettingField(key);
      if (!field) {
        return reply.code(400).send({ error: `Unknown setting: ${key}` });
      }
      try {
        const parsed = parseSettingValue(field, raw);
        validateSettingValue(field, parsed);
        validated[key] = parsed;
      } catch (error) {
        if (error instanceof SettingValidationError) {
          return reply.code(400).send({ error: error.message, key: error.key });
        }
        throw error;
      }
    }

    if (Object.keys(validated).length === 0) {
      return reply.code(400).send({ error: "No settings to update" });
    }

    await repos.setAppSettings(validated, "admin");
    await repos
      .appendAuditEvent({
        actor: "admin",
        action: "settings.updated",
        metadata: { keys: Object.keys(validated) },
      })
      .catch(() => undefined);

    const overrides = await repos.getAppSettings();
    return buildSettingsView(process.env, overrides);
  });
}
