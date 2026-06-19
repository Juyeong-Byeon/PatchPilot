export interface PublishInput {
  jobId: string;
  runId: string;
  repository: string;
  targetBranch: string;
  workBranch: string;
  localRepoDir?: string;
  baseSha: string;
  headSha: string;
  commitShas: string[];
  title: string;
  body: string;
}

export interface PublishedPullRequest {
  repository: string;
  targetBranch: string;
  workBranch: string;
  baseSha: string;
  headSha: string;
  commitShas: string[];
  prUrl: string;
  prNumber: number;
  prTitle: string;
  prBody: string;
}

export async function publishMockPullRequest(input: PublishInput): Promise<PublishedPullRequest> {
  return {
    repository: input.repository,
    targetBranch: input.targetBranch,
    workBranch: input.workBranch,
    baseSha: input.baseSha,
    headSha: input.headSha,
    commitShas: input.commitShas,
    prUrl: `https://github.local/${input.repository}/pull/mock-${input.jobId}`,
    prNumber: 1,
    prTitle: input.title,
    prBody: input.body
  };
}
