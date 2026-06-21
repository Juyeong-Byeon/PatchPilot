import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createSecretRedactor } from "@ticket-to-pr/core";

export function runGstack(repoDir: string, logPath: string, timeoutMs: number, killGraceMs = 2000): Promise<void> {
  const command = process.env.GSTACK_COMMAND?.trim() || "gstack";
  const args = parseArgs(process.env.GSTACK_ARGS ?? "ship --no-push");

  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let child: ReturnType<typeof spawn> | undefined;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    mkdir(path.dirname(logPath), { recursive: true })
      .then(() => {
        const logStream = createWriteStream(logPath, { flags: "a" });
        child = spawn(command, args, {
          cwd: repoDir,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (child.stdout === null || child.stderr === null) {
          throw new Error("gstack process streams were not available");
        }
        const stdoutRedactor = createSecretRedactor();
        const stderrRedactor = createSecretRedactor();

        timer = setTimeout(() => {
          timedOut = true;
          terminateProcessGroup(child, "SIGTERM");
          killTimer = setTimeout(() => {
            terminateProcessGroup(child, "SIGKILL");
          }, killGraceMs);
        }, timeoutMs);

        // Tee the (redacted) gstack output to BOTH the per-run log file and this
        // process's stdout/stderr. The platform captures the runner's stdout, so
        // echoing here is what surfaces the staged `=== gstack stage N/M: ... ===`
        // banners (→ gstack.stage events → the admin sub-track) and the live agent
        // output. Without it, gstack output is trapped in the log file and the
        // platform only ever sees the runner's own console logs.
        child.stdout.on("data", (chunk: Buffer) => {
          const redacted = stdoutRedactor(chunk.toString("utf8"));
          logStream.write(redacted);
          process.stdout.write(redacted);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          const redacted = stderrRedactor(chunk.toString("utf8"));
          logStream.write(redacted);
          process.stderr.write(redacted);
        });

        child.on("error", (error) => {
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          if (killTimer !== undefined) {
            clearTimeout(killTimer);
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
          if (killTimer !== undefined) {
            clearTimeout(killTimer);
          }

          const stdoutTail = stdoutRedactor("", true);
          const stderrTail = stderrRedactor("", true);
          logStream.write(stdoutTail);
          logStream.write(stderrTail);
          if (stdoutTail) process.stdout.write(stdoutTail);
          if (stderrTail) process.stderr.write(stderrTail);
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

function terminateProcessGroup(child: ReturnType<typeof spawn> | undefined, signal: NodeJS.Signals): void {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function parseArgs(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}
