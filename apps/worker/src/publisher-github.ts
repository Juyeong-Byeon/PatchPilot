import { spawn } from "node:child_process";
import { Octokit } from "@octokit/rest";
import { maskSecrets } from "@ticket-to-pr/core";
import { buildSafeGitArgs } from "./git-safe.js";
import type { PublishInput, PublishedPullRequest } from "./publisher-mock.js";

interface PullsApiOctokit {
  rest: {
    pulls: {
      create(input: {
        owner: string;
        repo: string;
        title: string;
        body: string;
        head: string;
        base: string;
        draft: boolean;
      }): Promise<{ data: { html_url: string; number: number } }>;
      list(input: {
        owner: string;
        repo: string;
        head: string;
        base: string;
        state: "open" | "closed" | "all";
      }): Promise<{ data: Array<{ html_url: string; number: number }> }>;
      update(input: {
        owner: string;
        repo: string;
        pull_number: number;
        title: string;
        body: string;
      }): Promise<{ data: { html_url: string; number: number } }>;
    };
  };
}

export type PushBranch = (repoDir: string, workBranch: string, pushSha: string, token?: string) => Promise<void>;

export function createGitHubPublisher(token: string): (input: PublishInput) => Promise<PublishedPullRequest> {
  const octokit = new Octokit({ auth: token });
  return (input) => publishGitHubPullRequest(input, octokit, pushBranchToOrigin, token);
}

export async function publishGitHubPullRequest(
  input: PublishInput,
  octokit: PullsApiOctokit,
  pushBranch: PushBranch = pushBranchToOrigin,
  githubToken?: string,
): Promise<PublishedPullRequest> {
  const [owner, repo] = input.repository.split("/");
  if (!owner || !repo) throw new Error(`Invalid GitHub repository: ${input.repository}`);
  if (!input.localRepoDir) throw new Error("localRepoDir is required for GitHub publishing");

  await pushBranch(input.localRepoDir, input.workBranch, input.pushSha, githubToken);

  // X2 publish idempotency: a retry (or a prior attempt that pushed the branch but
  // failed during pulls.create — the "orphan branch" case) must not open a second
  // PR for the same head→base. Look up an existing open PR for this head first and,
  // when found, reuse it (refreshing title/body) instead of creating a duplicate.
  // GitHub's pulls.list `head` filter is owner-qualified.
  const existing = await findOpenPullRequest(octokit, owner, repo, input.workBranch, input.targetBranch);
  const data = existing
    ? (
        await octokit.rest.pulls.update({
          owner,
          repo,
          pull_number: existing.number,
          title: input.title,
          body: input.body,
        })
      ).data
    : (
        await octokit.rest.pulls.create({
          owner,
          repo,
          title: input.title,
          body: input.body,
          head: input.workBranch,
          base: input.targetBranch,
          draft: false,
        })
      ).data;

  return {
    repository: input.repository,
    targetBranch: input.targetBranch,
    workBranch: input.workBranch,
    baseSha: input.baseSha,
    headSha: input.headSha,
    pushSha: input.pushSha,
    commitShas: input.commitShas,
    prUrl: data.html_url,
    prNumber: data.number,
    prTitle: input.title,
    prBody: input.body,
  };
}

/**
 * Find an existing open PR for `workBranch → targetBranch`, or undefined when none
 * exists. Best-effort: a transient list failure (e.g. permissions on a fresh repo)
 * is swallowed so publishing degrades to the create path rather than failing the
 * whole job — the `(repository, pr_number)` unique constraint remains the final
 * dedup backstop on savePullRequest.
 */
async function findOpenPullRequest(
  octokit: PullsApiOctokit,
  owner: string,
  repo: string,
  workBranch: string,
  targetBranch: string,
): Promise<{ html_url: string; number: number } | undefined> {
  try {
    const response = await octokit.rest.pulls.list({
      owner,
      repo,
      head: `${owner}:${workBranch}`,
      base: targetBranch,
      state: "open",
    });
    return response.data[0];
  } catch {
    return undefined;
  }
}

export async function pushBranchToOrigin(
  repoDir: string,
  workBranch: string,
  pushSha: string,
  token?: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", buildSafeGitArgs(["push", "origin", `${pushSha}:refs/heads/${workBranch}`], repoDir), {
      cwd: repoDir,
      env: token ? buildGitAuthEnv(process.env, token) : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`git push failed with code ${code ?? "unknown"}: ${maskSecrets(stderr)}`));
    });
  });
}

function buildGitAuthEnv(source: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    ...source,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${encoded}`,
  };
}
