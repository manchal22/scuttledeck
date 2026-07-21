package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/scuttledeck/scuttledeck/internal/alerts"
)

func postEvent(t *testing.T, event string, payload string) *http.Response {
	t.Helper()
	body := []byte(payload)
	req, _ := http.NewRequest(http.MethodPost, server.URL+"/webhooks/github", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-GitHub-Event", event)
	req.Header.Set("X-GitHub-Delivery", "evt-"+event+"-"+time.Now().Format("150405.000000"))
	req.Header.Set("X-Hub-Signature-256", sign(body))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func TestPullRequestLifecycle(t *testing.T) {
	res := postEvent(t, "pull_request", `{
		"action": "opened",
		"pull_request": {"number": 77, "title": "Add sonar pings", "state": "open",
			"created_at": "2026-07-20T09:00:00Z", "user": {"login": "mira-chen"}, "head": {"ref": "feat/pings"}},
		"repository": {"id": 812345678, "full_name": "acme-fixture/api", "default_branch": "main"}
	}`)
	if res.StatusCode != http.StatusAccepted {
		t.Fatalf("want 202, got %d", res.StatusCode)
	}

	waitFor(t, "open PR row", func() bool {
		var state string
		err := pool.QueryRow(context.Background(),
			`select state from pull_request where pr_number = 77`).Scan(&state)
		return err == nil && state == "open"
	})

	postEvent(t, "pull_request", `{
		"action": "closed",
		"pull_request": {"number": 77, "state": "closed", "merged": true,
			"merged_at": "2026-07-21T10:00:00Z", "closed_at": "2026-07-21T10:00:00Z",
			"user": {"login": "mira-chen"}},
		"repository": {"id": 812345678, "full_name": "acme-fixture/api"}
	}`)

	waitFor(t, "merged PR row", func() bool {
		var merged bool
		var author string
		err := pool.QueryRow(context.Background(),
			`select merged, author from pull_request where pr_number = 77`).Scan(&merged, &author)
		return err == nil && merged && author == "mira-chen"
	})
}

func TestAlertBudgetFiresOncePerCooldown(t *testing.T) {
	ctx := context.Background()
	cfg, _ := json.Marshal(map[string]any{"monthly_usd": 0.5, "warn_fraction": 0.8})
	var ruleID int64
	if err := pool.QueryRow(ctx,
		`insert into alert_rule (kind, config, enabled) values ('budget', $1, true) returning id`,
		cfg).Scan(&ruleID); err != nil {
		t.Fatal(err)
	}
	// Sessions from earlier tests carry ~$1.23 cost this month — over budget.
	if err := alerts.Evaluate(ctx, pool, ""); err != nil {
		t.Fatal(err)
	}
	var events int
	if err := pool.QueryRow(ctx,
		`select count(*) from alert_event where rule_id = $1`, ruleID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if events != 1 {
		t.Fatalf("want exactly 1 alert event, got %d", events)
	}
	// Within cooldown: evaluating again must not re-fire.
	if err := alerts.Evaluate(ctx, pool, ""); err != nil {
		t.Fatal(err)
	}
	_ = pool.QueryRow(ctx, `select count(*) from alert_event where rule_id = $1`, ruleID).Scan(&events)
	if events != 1 {
		t.Fatalf("cooldown violated: %d events", events)
	}
}

func TestFailureRateAlert(t *testing.T) {
	ctx := context.Background()
	cfg, _ := json.Marshal(map[string]any{"threshold": 0.1, "window_hours": 48, "min_runs": 1})
	var ruleID int64
	if err := pool.QueryRow(ctx,
		`insert into alert_rule (kind, config, enabled) values ('failure_rate', $1, true) returning id`,
		cfg).Scan(&ruleID); err != nil {
		t.Fatal(err)
	}
	// Ensure at least one recent failed run exists.
	if _, err := pool.Exec(ctx, `
		insert into run (repo_id, gh_run_id, status, conclusion, run_started_at)
		select id, 16999900099, 'completed', 'failure', now() - interval '1 hour' from repo limit 1
		on conflict (gh_run_id) do nothing`); err != nil {
		t.Fatal(err)
	}
	if err := alerts.Evaluate(ctx, pool, ""); err != nil {
		t.Fatal(err)
	}
	var summary string
	if err := pool.QueryRow(ctx,
		`select summary from alert_event where rule_id = $1`, ruleID).Scan(&summary); err != nil {
		t.Fatalf("failure_rate alert did not fire: %v", err)
	}
	t.Logf("fired: %s", summary)
}
