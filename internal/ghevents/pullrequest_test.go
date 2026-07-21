package ghevents

import "testing"

func TestParsePullRequestEvent(t *testing.T) {
	payload := []byte(`{
		"action": "closed",
		"pull_request": {
			"number": 42, "title": "Add rate limiter", "state": "closed",
			"merged": true, "merged_at": "2026-07-21T10:00:00Z",
			"user": {"login": "mira-chen"}, "head": {"ref": "feat/x"},
			"future_field": true
		},
		"repository": {"id": 1, "full_name": "acme/api"}
	}`)
	evt, err := ParsePullRequestEvent(payload)
	if err != nil {
		t.Fatal(err)
	}
	if *evt.PullRequest.Number != 42 || !*evt.PullRequest.Merged || *evt.PullRequest.User.Login != "mira-chen" {
		t.Errorf("parsed wrong: %+v", evt.PullRequest)
	}

	if _, err := ParsePullRequestEvent([]byte(`{"action":"opened"}`)); err == nil {
		t.Error("missing fields should fail validation")
	}
}

func TestPushEventTouchesWorkflows(t *testing.T) {
	touch := PushEvent{Commits: []struct {
		Added    []string `json:"added"`
		Modified []string `json:"modified"`
		Removed  []string `json:"removed"`
	}{{Modified: []string{"src/main.go", ".github/workflows/claude.yml"}}}}
	if !touch.TouchesWorkflows() {
		t.Error("workflow change not detected")
	}
	noTouch := PushEvent{Commits: []struct {
		Added    []string `json:"added"`
		Modified []string `json:"modified"`
		Removed  []string `json:"removed"`
	}{{Modified: []string{"README.md"}}}}
	if noTouch.TouchesWorkflows() {
		t.Error("false positive on non-workflow change")
	}
}
