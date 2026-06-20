import { describe, expect, it } from "vitest";
import { buildSafeGitArgs } from "../src/git-safe.js";

describe("buildSafeGitArgs", () => {
  it("adds a command-scoped safe.directory for runner-owned repositories", () => {
    expect(buildSafeGitArgs(["rev-parse", "--verify", "HEAD^{commit}"], "/work/jobs/job_1/repo")).toEqual([
      "-c",
      "safe.directory=/work/jobs/job_1/repo",
      "rev-parse",
      "--verify",
      "HEAD^{commit}"
    ]);
  });

  it("leaves commands without a repository directory unchanged", () => {
    expect(buildSafeGitArgs(["ls-remote", "--heads", "https://github.com/acme/web.git", "main"])).toEqual([
      "ls-remote",
      "--heads",
      "https://github.com/acme/web.git",
      "main"
    ]);
  });
});
