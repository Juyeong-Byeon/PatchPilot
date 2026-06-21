import { describe, expect, it } from "vitest";
import { createGitHubOctokit } from "../src/github-octokit.js";

describe("createGitHubOctokit", () => {
  it("constructs a throttled Octokit exposing the REST pulls surface", () => {
    // Construction itself is the load-bearing assertion: @octokit/plugin-throttling
    // throws at construction time if either onRateLimit or onSecondaryRateLimit is
    // missing, so a regression that dropped a handler would fail here. No network is
    // touched — Octokit is lazy and we never issue a request.
    const octokit = createGitHubOctokit("token-unused-no-network");
    expect(typeof octokit.rest.pulls.get).toBe("function");
    expect(typeof octokit.rest.pulls.list).toBe("function");
    expect(typeof octokit.rest.pulls.create).toBe("function");
    expect(typeof octokit.rest.pulls.update).toBe("function");
  });
});
