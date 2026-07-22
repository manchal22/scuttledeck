// Package poller runs the scheduled ingestion planes: workflow discovery,
// the Anthropic Admin API tiers (Analytics + cost report), the alert
// evaluator, and retention sweeps. Every poller is env-gated — absent
// credentials simply disable a plane, they never error.
package poller

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/scuttledeck/scuttledeck/internal/alerts"
	"github.com/scuttledeck/scuttledeck/internal/discovery"
	"github.com/scuttledeck/scuttledeck/internal/githubapp"
)

type Config struct {
	// GitHub token for the discovery scanner (PAT until the App flow lands).
	GithubToken string
	// Org to scan; falls back to each installation's org column.
	GithubOrg string
	// Anthropic Admin API key (sk-ant-admin…) enables Analytics + cost report.
	AnthropicAdminKey string
	// Optional override for Anthropic API base (tests use a local server).
	AnthropicBaseURL string
	// Optional override for the GitHub API base (tests use a local server).
	GithubAPIBaseURL string
	// LiteLLM gateway base URL + admin key enable the gateway spend poller
	// (billing truth for deployments with no Anthropic invoice).
	LiteLLMBaseURL  string
	LiteLLMAdminKey string
	// Slack incoming-webhook URL for alert notifications.
	SlackWebhookURL string
	// Days of raw webhook deliveries to keep. <=0 disables the sweep.
	RetentionDays int

	DiscoveryInterval time.Duration
	AnalyticsInterval time.Duration
	CostInterval      time.Duration
	AlertInterval     time.Duration
}

func (c *Config) defaults() {
	if c.DiscoveryInterval == 0 {
		c.DiscoveryInterval = time.Hour
	}
	if c.AnalyticsInterval == 0 {
		c.AnalyticsInterval = time.Hour
	}
	if c.CostInterval == 0 {
		c.CostInterval = 24 * time.Hour
	}
	if c.AlertInterval == 0 {
		c.AlertInterval = 15 * time.Minute
	}
	if c.AnthropicBaseURL == "" {
		c.AnthropicBaseURL = "https://api.anthropic.com"
	}
}

// Start launches every enabled poller. Each runs immediately once, then on
// its interval, until ctx is cancelled.
func Start(ctx context.Context, pool *pgxpool.Pool, cfg Config) {
	cfg.defaults()

	// Discovery + redelivery authenticate with a PAT when configured, else
	// with GitHub App installation tokens once the setup flow has run.
	go every(ctx, cfg.DiscoveryInterval, "discovery", func() error {
		return RunDiscovery(ctx, pool, cfg)
	})
	// Sweep failed webhook deliveries: turns "ingest was down" from data
	// loss into a delayed arrival. Runs immediately on boot — exactly when
	// an outage just ended.
	go every(ctx, 30*time.Minute, "redelivery", func() error {
		return RunRedelivery(ctx, pool, cfg)
	})

	if cfg.AnthropicAdminKey != "" {
		go every(ctx, cfg.AnalyticsInterval, "analytics", func() error {
			return RunAnalytics(ctx, pool, cfg.AnthropicBaseURL, cfg.AnthropicAdminKey)
		})
		go every(ctx, cfg.CostInterval, "cost_report", func() error {
			return RunCostReport(ctx, pool, cfg.AnthropicBaseURL, cfg.AnthropicAdminKey)
		})
	} else {
		log.Println("[poller] anthropic pollers disabled (no ANTHROPIC_ADMIN_KEY)")
	}

	if cfg.LiteLLMBaseURL != "" && cfg.LiteLLMAdminKey != "" {
		go every(ctx, cfg.CostInterval, "litellm_spend", func() error {
			return RunLiteLLMSpend(ctx, pool, cfg.LiteLLMBaseURL, cfg.LiteLLMAdminKey)
		})
	}

	go every(ctx, cfg.AlertInterval, "alerts", func() error {
		return alerts.Evaluate(ctx, pool, cfg.SlackWebhookURL)
	})

	if cfg.RetentionDays > 0 {
		go every(ctx, 24*time.Hour, "retention", func() error {
			tag, err := pool.Exec(ctx,
				`delete from webhook_delivery where received_at < now() - $1::interval`,
				fmt.Sprintf("%d days", cfg.RetentionDays))
			if err == nil && tag.RowsAffected() > 0 {
				log.Printf("[retention] dropped %d old webhook deliveries", tag.RowsAffected())
			}
			return err
		})
	}
}

func every(ctx context.Context, interval time.Duration, name string, fn func() error) {
	run := func() {
		if err := fn(); err != nil {
			log.Printf("[poller:%s] %v", name, err)
		}
	}
	run()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			run()
		}
	}
}

// githubAuth is a token bound to one org scope.
type githubAuth struct {
	Org   string
	Token string
}

var authUnavailableOnce sync.Once

// resolveGithubAuths returns per-org tokens: the configured PAT applied to
// every known installation org, or App installation tokens when the GitHub
// App setup flow has run. Empty (no error) when neither is configured.
func resolveGithubAuths(ctx context.Context, pool *pgxpool.Pool, cfg Config) ([]githubAuth, error) {
	if cfg.GithubToken != "" {
		rows, err := pool.Query(ctx, `select org from installation`)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []githubAuth
		for rows.Next() {
			var org string
			if err := rows.Scan(&org); err != nil {
				return nil, err
			}
			if cfg.GithubOrg != "" {
				org = cfg.GithubOrg
			}
			out = append(out, githubAuth{Org: org, Token: cfg.GithubToken})
		}
		return out, rows.Err()
	}

	app, err := githubapp.Load(ctx, pool)
	if err != nil || app == nil {
		if err == nil {
			authUnavailableOnce.Do(func() {
				log.Println("[poller] discovery + redelivery idle: no GITHUB_TOKEN and no GitHub App (run /setup/github)")
			})
		}
		return nil, err
	}
	apiBase := cfg.GithubAPIBaseURL
	if apiBase == "" {
		apiBase = "https://api.github.com"
	}
	auths, err := app.InstallationTokens(ctx, apiBase)
	if err != nil {
		return nil, err
	}
	out := make([]githubAuth, 0, len(auths))
	for _, a := range auths {
		// installations discovered via the App become installation rows
		if _, err := pool.Exec(ctx, `
			insert into installation (org, github_install_id) values ($1, $2)
			on conflict (org) do update set github_install_id = excluded.github_install_id`,
			a.Org, a.InstallID); err != nil {
			return nil, err
		}
		out = append(out, githubAuth{Org: a.Org, Token: a.Token})
	}
	return out, nil
}

// RunDiscovery scans each authenticated org and persists the inventory.
func RunDiscovery(ctx context.Context, pool *pgxpool.Pool, cfg Config) error {
	auths, err := resolveGithubAuths(ctx, pool, cfg)
	if err != nil || len(auths) == 0 {
		return err
	}
	for _, auth := range auths {
		var instID int64
		if err := pool.QueryRow(ctx,
			`select id from installation where org = $1`, auth.Org).Scan(&instID); err != nil {
			continue
		}
		client := discovery.NewRESTClient(auth.Token)
		results, err := discovery.ScanOrg(ctx, client, auth.Org)
		if err != nil {
			log.Printf("[discovery] scan %s: %v", auth.Org, err)
			continue
		}
		if err := discovery.PersistScan(ctx, pool, instID, results); err != nil {
			return err
		}
		hits := 0
		for _, r := range results {
			hits += len(r.Hits)
		}
		log.Printf("[discovery] %s: %d repos scanned, %d claude workflows", auth.Org, len(results), hits)
	}
	return nil
}
