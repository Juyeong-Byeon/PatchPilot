import type { FastifyInstance } from "fastify";

/** Build/version stamp returned by `GET /api/version` so operators can verify
 * exactly which build is serving traffic. */
export interface VersionInfo {
  /** The API package version (`@ticket-to-pr/api`). */
  version: string;
  /** The git commit the build was cut from, or null when the process was not
   * given one (e.g. local `npm run dev`). Never throws when GIT_SHA is unset. */
  sha: string | null;
}

// Fallback when the process is started without npm's package-version env var
// (e.g. `node dist/server.js` directly). Mirrors apps/api/package.json so the
// endpoint always reports a string, never undefined.
const FALLBACK_VERSION = "0.0.0";

function readVersion(env: NodeJS.ProcessEnv = process.env): string {
  const version = env.npm_package_version;
  return version && version.trim() !== "" ? version : FALLBACK_VERSION;
}

export async function registerVersionRoutes(app: FastifyInstance): Promise<void> {
  // Deployment introspection: cheap and dependency-free (like /api/health) so it
  // answers even when Postgres/Redis are down — the whole point is to confirm
  // what build is running during an incident.
  app.get(
    "/api/version",
    async (): Promise<VersionInfo> => ({
      version: readVersion(),
      sha: process.env.GIT_SHA ?? null,
    }),
  );
}
