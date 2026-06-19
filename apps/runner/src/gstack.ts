import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export function runGstack(repoDir: string, logPath: string, timeoutMs: number): Promise<void> {
  const command = process.env.GSTACK_COMMAND?.trim() || "gstack";
  const args = parseArgs(process.env.GSTACK_ARGS ?? "ship --no-push");

  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let child: ReturnType<typeof spawn> | undefined;
    let timer: NodeJS.Timeout | undefined;

    mkdir(path.dirname(logPath), { recursive: true })
      .then(() => {
        const logStream = createWriteStream(logPath, { flags: "a" });
        child = spawn(command, args, { cwd: repoDir, stdio: ["ignore", "pipe", "pipe"] });
        if (child.stdout === null || child.stderr === null) {
          throw new Error("gstack process streams were not available");
        }

        timer = setTimeout(() => {
          timedOut = true;
          child?.kill("SIGTERM");
        }, timeoutMs);

        child.stdout.pipe(logStream, { end: false });
        child.stderr.pipe(logStream, { end: false });

        child.on("error", (error) => {
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          logStream.end();
          if (!settled) {
            settled = true;
            reject(error);
          }
        });

        child.on("close", (code, signal) => {
          if (timer !== undefined) {
            clearTimeout(timer);
          }

          logStream.end(() => {
            if (settled) {
              return;
            }
            settled = true;

            if (timedOut) {
              reject(new Error(`gstack timed out after ${timeoutMs}ms`));
              return;
            }

            if (code === 0) {
              resolve();
              return;
            }

            reject(new Error(`gstack failed with exit code ${code ?? "null"}${signal ? ` signal ${signal}` : ""}`));
          });
        });
      })
      .catch(reject);
  });
}

function parseArgs(value: string): string[] {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}
