// Package alerts evaluates the built-in rule kinds — monthly
// budget, cost anomaly vs trailing median, failure-rate spike, stale action
// version — and notifies Slack. Each rule re-fires at most once per cooldown.
package alerts

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const defaultCooldown = 24 * time.Hour

type rule struct {
	ID     int64
	Kind   string
	Config map[string]any
}

func cfgFloat(c map[string]any, key string, fallback float64) float64 {
	if v, ok := c[key]; ok {
		if f, ok := v.(float64); ok {
			return f
		}
	}
	return fallback
}

// Evaluate runs every enabled rule once. Breaches insert an alert_event and
// post to Slack (when a webhook URL is configured globally or on the rule).
func Evaluate(ctx context.Context, pool *pgxpool.Pool, slackURL string) error {
	rows, err := pool.Query(ctx, `select id, kind, config from alert_rule where enabled`)
	if err != nil {
		return err
	}
	defer rows.Close()
	var rules []rule
	for rows.Next() {
		var r rule
		var cfg []byte
		if err := rows.Scan(&r.ID, &r.Kind, &cfg); err != nil {
			return err
		}
		_ = json.Unmarshal(cfg, &r.Config)
		if r.Config == nil {
			r.Config = map[string]any{}
		}
		rules = append(rules, r)
	}
	if err := rows.Err(); err != nil {
		return err
	}

	for _, r := range rules {
		summary, breach, err := evaluateRule(ctx, pool, r)
		if err != nil {
			log.Printf("[alerts] rule %d (%s): %v", r.ID, r.Kind, err)
			continue
		}
		if !breach {
			continue
		}
		fired, err := fireOnce(ctx, pool, r, summary)
		if err != nil {
			log.Printf("[alerts] firing rule %d: %v", r.ID, err)
			continue
		}
		if fired {
			hook := slackURL
			if v, ok := r.Config["slack_webhook_url"].(string); ok && v != "" {
				hook = v
			}
			if hook != "" {
				notifySlack(hook, summary)
			}
		}
	}
	return nil
}

// fireOnce inserts an alert_event unless one fired within the cooldown.
func fireOnce(ctx context.Context, pool *pgxpool.Pool, r rule, summary string) (bool, error) {
	cooldown := time.Duration(cfgFloat(r.Config, "cooldown_hours", defaultCooldown.Hours())) * time.Hour
	var recent bool
	if err := pool.QueryRow(ctx,
		`select exists (select 1 from alert_event where rule_id = $1 and fired_at > now() - $2::interval)`,
		r.ID, cooldown.String()).Scan(&recent); err != nil {
		return false, err
	}
	if recent {
		return false, nil
	}
	_, err := pool.Exec(ctx,
		`insert into alert_event (rule_id, summary) values ($1, $2)`, r.ID, summary)
	return err == nil, err
}

func evaluateRule(ctx context.Context, pool *pgxpool.Pool, r rule) (string, bool, error) {
	switch r.Kind {
	case "budget":
		limit := cfgFloat(r.Config, "monthly_usd", 0)
		if limit <= 0 {
			return "", false, nil
		}
		var spend float64
		if err := pool.QueryRow(ctx, `
			select coalesce(sum(cost_usd), 0)::float from agent_session
			where first_seen_at >= date_trunc('month', now())`).Scan(&spend); err != nil {
			return "", false, err
		}
		if spend >= limit {
			return fmt.Sprintf("🚨 Budget: month-to-date Claude spend $%.2f crossed the $%.2f budget", spend, limit), true, nil
		}
		warnAt := cfgFloat(r.Config, "warn_fraction", 0.8)
		if spend >= limit*warnAt {
			return fmt.Sprintf("⚠️ Budget: month-to-date Claude spend $%.2f is at %.0f%% of the $%.2f budget", spend, spend/limit*100, limit), true, nil
		}
		return "", false, nil

	case "cost_anomaly":
		mult := cfgFloat(r.Config, "multiplier", 3)
		days := int(cfgFloat(r.Config, "trailing_days", 7))
		var today, median float64
		if err := pool.QueryRow(ctx, `
			select coalesce(sum(cost_usd), 0)::float from agent_session
			where first_seen_at >= date_trunc('day', now())`).Scan(&today); err != nil {
			return "", false, err
		}
		if err := pool.QueryRow(ctx, `
			select coalesce(percentile_cont(0.5) within group (order by daily), 0)::float
			from (
				select date_trunc('day', first_seen_at) d, sum(cost_usd) daily
				from agent_session
				where first_seen_at >= date_trunc('day', now()) - $1::interval
				  and first_seen_at < date_trunc('day', now())
				group by 1
			) t`, days).Scan(&median); err != nil {
			return "", false, err
		}
		if median > 0 && today > median*mult {
			return fmt.Sprintf("🚨 Cost anomaly: today's spend $%.2f is %.1f× the trailing %d-day median ($%.2f)", today, today/median, days, median), true, nil
		}
		return "", false, nil

	case "failure_rate":
		threshold := cfgFloat(r.Config, "threshold", 0.3)
		hours := int(cfgFloat(r.Config, "window_hours", 24))
		minRuns := int(cfgFloat(r.Config, "min_runs", 5))
		var completed, failed int
		if err := pool.QueryRow(ctx, `
			select count(*) filter (where status = 'completed'),
			       count(*) filter (where conclusion is not null and conclusion <> 'success')
			from run where run_started_at >= now() - $1::interval`,
			fmt.Sprintf("%d hours", hours)).Scan(&completed, &failed); err != nil {
			return "", false, err
		}
		if completed >= minRuns && float64(failed)/float64(completed) >= threshold {
			return fmt.Sprintf("🚨 Failure spike: %d of %d runs failed in the last %dh (%.0f%%, threshold %.0f%%)", failed, completed, hours, float64(failed)/float64(completed)*100, threshold*100), true, nil
		}
		return "", false, nil

	case "action_stale":
		days := int(cfgFloat(r.Config, "days", 14))
		var stale int
		var example string
		if err := pool.QueryRow(ctx, `
			with latest as (
				select max(action_version) v from workflow where action_version ~ '^v?[0-9]'
			)
			select count(*), coalesce(min(r.full_name), '')
			from workflow w join repo r on r.id = w.repo_id, latest
			where w.action_version is not null and w.action_version <> latest.v
			  and w.last_scanned_at < now() - $1::interval`,
			fmt.Sprintf("%d days", days)).Scan(&stale, &example); err != nil {
			return "", false, err
		}
		if stale > 0 {
			return fmt.Sprintf("⚠️ Version drift: %d workflow(s) run an outdated claude-code-action for >%dd (e.g. %s)", stale, days, example), true, nil
		}
		return "", false, nil
	}
	return "", false, fmt.Errorf("unknown rule kind %q", r.Kind)
}

func notifySlack(webhookURL, text string) {
	body, _ := json.Marshal(map[string]string{"text": text})
	res, err := http.Post(webhookURL, "application/json", bytes.NewReader(body))
	if err != nil {
		log.Printf("[alerts] slack notify failed: %v", err)
		return
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		log.Printf("[alerts] slack notify: HTTP %d", res.StatusCode)
	}
}
