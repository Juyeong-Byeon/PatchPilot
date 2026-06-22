import type { FastifyInstance } from "fastify";

/** Build/version stamp returned by `GET /api/version` so operators can verify
 * exactly which build is serving traffic. */
export interface VersionInfo {
  /** The running build's version: the latest semantic-release git tag stamped in
   * at build time (APP_VERSION), or the npm package version in local dev. */
  version: string;
  /** The git commit the build was cut from, or null when the process was not
   * given one (e.g. local `npm run dev`). Never throws when GIT_SHA is unset. */
  sha: string | null;
  /** Runtime environment name; useful when several local frontends are open. */
  nodeEnv: string;
  /** Effective executor mode visible to the API process: usually mock or gstack. */
  executorMode: string;
  /** Effective publisher mode visible to the API process: usually mock or github. */
  publisherMode: string;
  /** Public callback/base URL configured for this API, if any. */
  publicBaseUrl: string | null;
}

// Fallback when the process is started without any version stamp (e.g. a bare
// `node dist/server.js` from an image built without APP_VERSION). The endpoint
// always reports a string, never undefined.
const FALLBACK_VERSION = "0.0.0";

// Resolve the version in priority order:
//   1. APP_VERSION — stamped into the image at build time from the latest
//      semantic-release tag (scripts/build-stamp.mjs); this is what the admin's
//      bottom-left VersionBadge shows in a real deployment.
//   2. npm_package_version — set when started via npm (e.g. local `npm run dev`).
//   3. FALLBACK_VERSION — neither was provided.
function readVersion(env: NodeJS.ProcessEnv = process.env): string {
  const stamped = env.APP_VERSION;
  if (stamped !== undefined && stamped.trim() !== "") return stamped;
  const npmVersion = env.npm_package_version;
  return npmVersion !== undefined && npmVersion.trim() !== "" ? npmVersion : FALLBACK_VERSION;
}

function readNonBlank(value: string | undefined, fallback: string): string {
  return value !== undefined && value.trim() !== "" ? value.trim() : fallback;
}

function readNullable(value: string | undefined): string | null {
  return value !== undefined && value.trim() !== "" ? value.trim() : null;
}

function readPublisherMode(env: NodeJS.ProcessEnv = process.env): string {
  const raw = readNonBlank(env.WORKER_PUBLISHER_MODE ?? env.PUBLISHER_MODE, "mock").toLowerCase();
  // Match worker compatibility: legacy app-wide PUBLISHER_MODE=gstack means GitHub publishing.
  return raw === "gstack" ? "github" : raw;
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
      nodeEnv: readNonBlank(process.env.NODE_ENV, "development"),
      executorMode: readNonBlank(process.env.WORKER_EXECUTOR_MODE ?? process.env.EXECUTOR_MODE, "mock").toLowerCase(),
      publisherMode: readPublisherMode(),
      publicBaseUrl: readNullable(process.env.PUBLIC_BASE_URL),
    }),
  );
}
