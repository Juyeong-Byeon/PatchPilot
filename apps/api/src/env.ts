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

export function readApiEnv(env: NodeJS.ProcessEnv = process.env): ApiEnv {
  return {
    databaseUrl: requiredEnv(env, "DATABASE_URL"),
    redisUrl: requiredEnv(env, "REDIS_URL"),
    port: Number.parseInt(env.PORT ?? "3000", 10),
    adminToken: requiredEnv(env, "ADMIN_TOKEN"),
    larkWebhookSecret: requiredEnv(env, "LARK_WEBHOOK_SECRET"),
    githubWebhookSecret: optionalEnv(env, "GITHUB_WEBHOOK_SECRET"),
    larkRecordUpdaterConfig: readLarkRecordUpdaterConfig(env),
  };
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}
