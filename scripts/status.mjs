#!/usr/bin/env node
// Show the local stack state: container status plus the API readiness probe.
// A quick "is everything actually up and usable?" check.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEnvFile } from "./preflight.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const env = parseEnvFile(`${rootDir}.env`);
const port = env.HOST_API_PORT ?? process.env.HOST_API_PORT ?? "3000";

console.log("Containers:");
try {
  execFileSync("docker", ["compose", "ps"], { cwd: rootDir, stdio: "inherit" });
} catch {
  console.error("  Could not read container state (is Docker running?).");
}

console.log(`\nAPI readiness (http://localhost:${port}/api/ready):`);
try {
  const res = await fetch(`http://localhost:${port}/api/ready`);
  const body = await res.json().catch(() => ({}));
  console.log(`  HTTP ${res.status} ${JSON.stringify(body)}`);
} catch (error) {
  console.error(`  Unreachable: ${error instanceof Error ? error.message : error}`);
}
