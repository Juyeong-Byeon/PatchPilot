import { spawn } from "node:child_process";
import { maskSecrets } from "@ticket-to-pr/core";

export interface GitResult {
  stdout: string;
  stderr: string;
}

export function runGit(args: string[], cwd?: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: process.env.GITHUB_TOKEN ? buildGitAuthEnv(process.env, process.env.GITHUB_TOKEN) : process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const detail = stderr.trim() || stdout.trim() || `signal ${signal ?? "unknown"}`;
      reject(new Error(`git ${args.join(" ")} failed with exit code ${code ?? "null"}: ${maskSecrets(detail)}`));
    });
  });
}

export async function cloneRepository(repositoryUrl: string, repoDir: string): Promise<void> {
  await runGit(["clone", repositoryUrl, repoDir]);
}

export async function checkoutBaseAndCreateBranch(repoDir: string, targetBranch: string, workBranch: string): Promise<void> {
  await runGit(["fetch", "origin", targetBranch], repoDir);
  await runGit(["checkout", "-B", workBranch, `origin/${targetBranch}`], repoDir);
}

export async function getHeadSha(repoDir: string): Promise<string> {
  const { stdout } = await runGit(["rev-parse", "HEAD"], repoDir);
  return stdout.trim();
}

export async function hasLocalCommit(repoDir: string, targetBranch: string): Promise<boolean> {
  const { stdout } = await runGit(["rev-list", "--count", `origin/${targetBranch}..HEAD`], repoDir);
  return Number(stdout.trim()) > 0;
}

export async function getChangedFiles(repoDir: string, targetBranch: string): Promise<string[]> {
  const { stdout } = await runGit(["diff", "--name-only", `origin/${targetBranch}...HEAD`], repoDir);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function buildGitAuthEnv(source: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    ...source,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${encoded}`
  };
}
