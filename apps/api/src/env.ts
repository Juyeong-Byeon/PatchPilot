import { z } from "zod";
import { readLarkRecordUpdaterConfig, type LarkRecordUpdaterConfig } from "@ticket-to-pr/core";

export interface ApiEnv {
  databaseUrl: string;
  redisUrl: string;
  port: number;
  adminToken: string;
  larkWebhookSecret: string;
  githubWebhookSecret?: string | undefined;
  larkRecordUpdaterConfig?: LarkRecordUpdaterConfig | undefined;
}

// An unset var and a present-but-blank var are both treated as "absent" (matches
// the prior requiredEnv/optionalEnv `!value` / trim semantics).
const blankToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const required = (name: string): z.ZodEffects<z.ZodString, string, unknown> =>
  z.preprocess(blankToUndefined, z.string({ required_error: `${name} is required` }));

// Schema for the raw process.env. Validating declaratively (zod) instead of
// throwing on the first missing var means a misconfigured deploy fails fast with
// ALL problems reported at once. PORT is coerced + range-checked (the prior
// Number.parseInt silently yielded NaN on a non-numeric value). Tier-2 pilot per
// docs/library-adoption-plan.md; the worker's alias-heavy parser stays as-is.
const ApiEnvSchema = z.object({
  DATABASE_URL: required("DATABASE_URL"),
  REDIS_URL: required("REDIS_URL"),
  ADMIN_TOKEN: required("ADMIN_TOKEN"),
  LARK_WEBHOOK_SECRET: required("LARK_WEBHOOK_SECRET"),
  PORT: z.preprocess(blankToUndefined, z.coerce.number().int().positive().default(3000)),
  GITHUB_WEBHOOK_SECRET: z.preprocess(blankToUndefined, z.string().optional()),
});

export function readApiEnv(env: NodeJS.ProcessEnv = process.env): ApiEnv {
  const result = ApiEnvSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid API environment: ${issues}`);
  }
  const parsed = result.data;
  return {
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    port: parsed.PORT,
    adminToken: parsed.ADMIN_TOKEN,
    larkWebhookSecret: parsed.LARK_WEBHOOK_SECRET,
    githubWebhookSecret: parsed.GITHUB_WEBHOOK_SECRET,
    larkRecordUpdaterConfig: readLarkRecordUpdaterConfig(env),
  };
}
