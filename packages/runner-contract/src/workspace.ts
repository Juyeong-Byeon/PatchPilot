import path from "node:path";

export interface WorkspacePaths {
  inputDir: string;
  repoDir: string;
  outputDir: string;
  logsDir: string;
  ticketMd: string;
  contextJson: string;
  policyJson: string;
  resultJson: string;
  prTitle: string;
  prBody: string;
}

export function getWorkspacePaths(root: string): WorkspacePaths {
  const inputDir = path.join(root, "input");
  const repoDir = path.join(root, "repo");
  const outputDir = path.join(root, "output");
  const logsDir = path.join(root, "logs");

  return {
    inputDir,
    repoDir,
    outputDir,
    logsDir,
    ticketMd: path.join(inputDir, "ticket.md"),
    contextJson: path.join(inputDir, "context.json"),
    policyJson: path.join(inputDir, "policy.json"),
    resultJson: path.join(outputDir, "result.json"),
    prTitle: path.join(outputDir, "pr-title.txt"),
    prBody: path.join(outputDir, "pr-body.md"),
  };
}
