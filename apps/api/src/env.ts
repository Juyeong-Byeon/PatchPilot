export interface ApiEnv {
  databaseUrl: string;
  redisUrl: string;
  port: number;
  adminToken: string;
}

export function readApiEnv(env: NodeJS.ProcessEnv = process.env): ApiEnv {
  return {
    databaseUrl: requiredEnv(env, "DATABASE_URL"),
    redisUrl: requiredEnv(env, "REDIS_URL"),
    port: Number.parseInt(env.PORT ?? "3000", 10),
    adminToken: requiredEnv(env, "ADMIN_TOKEN")
  };
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
