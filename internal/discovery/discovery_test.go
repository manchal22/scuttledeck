package discovery

import (
	"context"
	"sort"
	"testing"
)

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
          token: ${{ secrets.SCUTTLEDECK_TOKEN }}
      - uses: anthropics/claude-code-action@v1.2.3
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          model: claude-sonnet-5
`

const ciWorkflow = `
name: CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`

func TestUsesClaudeCodeAction(t *testing.T) {
	cases := map[string]bool{
		"anthropics/claude-code-action@v1":           true,
		"my-fork/claude-code-action@main":            true,
		"anthropics/claude-code-base-action@beta":    true,
		"actions/checkout@v4":                        false,
		"anthropics/claude-code-action-lookalike@v1": false,
	}
	for uses, want := range cases {
		if got := UsesClaudeCodeAction(uses); got != want {
			t.Errorf("%s: want %v got %v", uses, want, got)
		}
	}
}

func TestParseWorkflowFile(t *testing.T) {
	hit := ParseWorkflowFile(".github/workflows/claude.yml", claudeWorkflow)
	if hit == nil {
		t.Fatal("expected a hit")
	}
	if hit.ActionRef != "anthropics/claude-code-action@v1.2.3" || hit.ActionVersion != "v1.2.3" {
		t.Errorf("ref/version wrong: %+v", hit)
	}
	triggers := append([]string(nil), hit.Triggers...)
	sort.Strings(triggers)
	if len(triggers) != 2 || triggers[0] != "issue_comment" || triggers[1] != "pull_request" {
		t.Errorf("triggers wrong: %v", hit.Triggers)
	}
	if hit.Name != "Claude PR Review" {
		t.Errorf("name wrong: %q", hit.Name)
	}
	if hit.ModelConfig["model"] != "claude-sonnet-5" {
		t.Errorf("model config wrong: %v", hit.ModelConfig)
	}

	if ParseWorkflowFile("ci.yml", ciWorkflow) != nil {
		t.Error("CI workflow false positive")
	}
	if ParseWorkflowFile("x.yml", "{{{{ not yaml") != nil {
		t.Error("invalid YAML should return nil")
	}
}

type fakeClient struct{}

func (fakeClient) ListRepos(_ context.Context, _ string) ([]RepoRef, error) {
	return []RepoRef{
		{ID: 1, FullName: "acme/api", DefaultBranch: "main"},
		{ID: 2, FullName: "acme/web", DefaultBranch: "main"},
	}, nil
}

func (fakeClient) ListWorkflowPaths(_ context.Context, _, repo string) ([]string, error) {
	if repo == "api" {
		return []string{".github/workflows/claude.yml", ".github/workflows/ci.yml"}, nil
	}
	return nil, nil
}

func (fakeClient) GetFileContent(_ context.Context, _, _, path string) (string, error) {
	if path == ".github/workflows/claude.yml" {
		return claudeWorkflow, nil
	}
	return ciWorkflow, nil
}

func TestScanOrg(t *testing.T) {
	results, err := ScanOrg(context.Background(), fakeClient{}, "acme")
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 2 {
		t.Fatalf("want 2 repos, got %d", len(results))
	}
	if len(results[0].Hits) != 1 || len(results[1].Hits) != 0 {
		t.Errorf("hit counts wrong: %d, %d", len(results[0].Hits), len(results[1].Hits))
	}
}
