// Package poller runs the scheduled ingestion planes: workflow discovery,
// the Anthropic Admin API tiers (Analytics + cost report), the alert
// evaluator, and retention sweeps. Every poller is env-gated — absent
// credentials simply disable a plane, they never error.
package poller

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/scuttledeck/scuttledeck/internal/alerts"
	"github.com/scuttledeck/scuttledeck/internal/discovery"
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

	if cfg.GithubToken != "" {
		go every(ctx, cfg.DiscoveryInterval, "discovery", func() error {
			return RunDiscovery(ctx, pool, cfg.GithubToken, cfg.GithubOrg)
		})
	} else {
		log.Println("[poller] discovery disabled (no GITHUB_TOKEN)")
	}

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

// RunDiscovery scans each installation's org and persists the inventory.
func RunDiscovery(ctx context.Context, pool *pgxpool.Pool, token, orgOverride string) error {
	rows, err := pool.Query(ctx, `select id, org from installation`)
	if err != nil {
		return err
	}
	defer rows.Close()
	type inst struct {
		id  int64
		org string
	}
	var insts []inst
	for rows.Next() {
		var i inst
		if err := rows.Scan(&i.id, &i.org); err != nil {
			return err
		}
		insts = append(insts, i)
	}
	if err := rows.Err(); err != nil {
		return err
	}

	client := discovery.NewRESTClient(token)
	for _, i := range insts {
		org := i.org
		if orgOverride != "" {
			org = orgOverride
		}
		results, err := discovery.ScanOrg(ctx, client, org)
		if err != nil {
			log.Printf("[discovery] scan %s: %v", org, err)
			continue
		}
		if err := discovery.PersistScan(ctx, pool, i.id, results); err != nil {
			return err
		}
		hits := 0
		for _, r := range results {
			hits += len(r.Hits)
		}
		log.Printf("[discovery] %s: %d repos scanned, %d claude workflows", org, len(results), hits)
	}
	return nil
}
