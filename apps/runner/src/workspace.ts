import { mkdir } from "node:fs/promises";
import { getWorkspacePaths, type WorkspacePaths } from "@ticket-to-pr/runner-contract";

export async function prepareWorkspace(root: string): Promise<WorkspacePaths> {
  const paths = getWorkspacePaths(root);
  await Promise.all([
    mkdir(paths.inputDir, { recursive: true }),
    mkdir(paths.repoDir, { recursive: true }),
    mkdir(paths.outputDir, { recursive: true }),
    mkdir(paths.logsDir, { recursive: true })
  ]);
  return paths;
}
