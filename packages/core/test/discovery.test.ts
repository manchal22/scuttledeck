import { describe, expect, it } from "vitest";
import { parseWorkflowFile, scanOrg, usesClaudeCodeAction, type DiscoveryClient } from "../src/discovery.js";

const claudeWorkflow = `
name: Claude PR Review
on:
  pull_request:
    types: [opened, synchronize]
  issue_comment:
    types: [created]
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: scuttledeck/setup@v1
        with:
          endpoint: https://scuttledeck.internal
          token: \${{ secrets.SCUTTLEDECK_TOKEN }}
      - uses: anthropics/claude-code-action@v1.2.3
        with:
          anthropic_api_key: \${{ secrets.ANTHROPIC_API_KEY }}
          model: claude-sonnet-5
`;

const ciWorkflow = `
name: CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`;

describe("usesClaudeCodeAction", () => {
  it("matches the official action, forks, and the base action", () => {
    expect(usesClaudeCodeAction("anthropics/claude-code-action@v1")).toBe(true);
    expect(usesClaudeCodeAction("my-fork/claude-code-action@main")).toBe(true);
    expect(usesClaudeCodeAction("anthropics/claude-code-base-action@beta")).toBe(true);
    expect(usesClaudeCodeAction("actions/checkout@v4")).toBe(false);
    expect(usesClaudeCodeAction("anthropics/claude-code-action-lookalike@v1")).toBe(false);
  });
});

describe("parseWorkflowFile", () => {
  it("finds the action with ref, version, triggers, and model config", () => {
    const hit = parseWorkflowFile(".github/workflows/claude.yml", claudeWorkflow);
    expect(hit).not.toBeNull();
    expect(hit!.actionRef).toBe("anthropics/claude-code-action@v1.2.3");
    expect(hit!.actionVersion).toBe("v1.2.3");
    expect(hit!.triggers.sort()).toEqual(["issue_comment", "pull_request"]);
    expect(hit!.name).toBe("Claude PR Review");
    expect(hit!.modelConfig).toEqual({ model: "claude-sonnet-5" });
  });

  it("returns null for workflows not using the action", () => {
    expect(parseWorkflowFile(".github/workflows/ci.yml", ciWorkflow)).toBeNull();
  });

  it("survives invalid YAML", () => {
    expect(parseWorkflowFile("x.yml", "{{{{ not yaml")).toBeNull();
  });
});

describe("scanOrg", () => {
  it("scans repos via an injected client", async () => {
    const client: DiscoveryClient = {
      listRepos: async () => [
        { id: 1, full_name: "acme/api", default_branch: "main" },
        { id: 2, full_name: "acme/web", default_branch: "main" },
      ],
      listWorkflowPaths: async (_o, repoName) =>
        repoName === "api"
          ? [".github/workflows/claude.yml", ".github/workflows/ci.yml"]
          : [],
      getFileContent: async (_o, _r, path) =>
        path.endsWith("claude.yml") ? claudeWorkflow : ciWorkflow,
    };
    const results = await scanOrg(client, "acme");
    expect(results).toHaveLength(2);
    expect(results[0]!.hits).toHaveLength(1);
    expect(results[1]!.hits).toHaveLength(0);
  });
});
