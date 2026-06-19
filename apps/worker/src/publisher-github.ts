import { spawn } from "node:child_process";
import { Octokit } from "@octokit/rest";
import { maskSecrets } from "@ticket-to-pr/core";
import type { PublishInput, PublishedPullRequest } from "./publisher-mock.js";

interface PullsCreateOctokit {
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
  octokit: PullsCreateOctokit,
  pushBranch: PushBranch = pushBranchToOrigin,
  githubToken?: string
): Promise<PublishedPullRequest> {
  const [owner, repo] = input.repository.split("/");
  if (!owner || !repo) throw new Error(`Invalid GitHub repository: ${input.repository}`);
  if (!input.localRepoDir) throw new Error("localRepoDir is required for GitHub publishing");

  await pushBranch(input.localRepoDir, input.workBranch, input.pushSha, githubToken);

  const response = await octokit.rest.pulls.create({
    owner,
    repo,
    title: input.title,
    body: input.body,
    head: input.workBranch,
    base: input.targetBranch,
    draft: true
  });

  return {
    repository: input.repository,
    targetBranch: input.targetBranch,
    workBranch: input.workBranch,
    baseSha: input.baseSha,
    headSha: input.headSha,
    pushSha: input.pushSha,
    commitShas: input.commitShas,
    prUrl: response.data.html_url,
    prNumber: response.data.number,
    prTitle: input.title,
    prBody: input.body
  };
}

export async function pushBranchToOrigin(repoDir: string, workBranch: string, pushSha: string, token?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["push", "origin", `${pushSha}:refs/heads/${workBranch}`], {
      cwd: repoDir,
      env: token ? buildGitAuthEnv(process.env, token) : process.env,
      stdio: ["ignore", "pipe", "pipe"]
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
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${encoded}`
  };
}
