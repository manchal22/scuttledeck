package poller

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Tier-1 (Analytics) and Tier-3 (cost report) pollers against the Anthropic
// Admin API. Parsing is tolerant: unknown fields ignored, malformed records
// logged and skipped — schema drift must never crash the poller.

const anthropicVersion = "2023-06-01"

func adminGet(ctx context.Context, baseURL, key, path string, params url.Values) ([]byte, error) {
	u := baseURL + path
	if len(params) > 0 {
		u += "?" + params.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("x-api-key", key)
	req.Header.Set("anthropic-version", anthropicVersion)
	res, err := (&http.Client{Timeout: 60 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 50<<20))
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: HTTP %d: %.200s", path, res.StatusCode, body)
	}
	return body, nil
}

// flexFloat tolerates numbers arriving as JSON numbers or strings.
type flexFloat float64

func (f *flexFloat) UnmarshalJSON(b []byte) error {
	if len(b) == 0 || string(b) == "null" {
		return nil
	}
	if b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return nil
		}
		if n, err := strconv.ParseFloat(s, 64); err == nil {
			*f = flexFloat(n)
		}
		return nil
	}
	var n float64
	if err := json.Unmarshal(b, &n); err != nil {
		return nil
	}
	*f = flexFloat(n)
	return nil
}

type analyticsRecord struct {
	Date     string `json:"date"`
	Actor    string `json:"actor"`
	APIActor string `json:"api_actor"`
	CoreMetrics struct {
		NumSessions int `json:"num_sessions"`
	} `json:"core_metrics"`
	ModelBreakdown []struct {
		Model  string `json:"model"`
		Tokens struct {
			Input         flexFloat `json:"input"`
			Output        flexFloat `json:"output"`
			CacheRead     flexFloat `json:"cache_read"`
			CacheCreation flexFloat `json:"cache_creation"`
		} `json:"tokens"`
		EstimatedCost struct {
			Amount   flexFloat `json:"amount"` // cents
			Currency string    `json:"currency"`
		} `json:"estimated_cost"`
	} `json:"model_breakdown"`
}

type analyticsPage struct {
	Data     []json.RawMessage `json:"data"`
	HasMore  bool              `json:"has_more"`
	NextPage string            `json:"next_page"`
}

// RunAnalytics ingests the Claude Code Analytics report (per-actor per-day
// sessions, tokens, estimated cost) into cost_daily.
func RunAnalytics(ctx context.Context, pool *pgxpool.Pool, baseURL, key string) error {
	params := url.Values{}
	params.Set("starting_at", time.Now().AddDate(0, 0, -7).UTC().Format("2006-01-02"))
	params.Set("limit", "1000")

	for {
		body, err := adminGet(ctx, baseURL, key, "/v1/organizations/usage_report/claude_code", params)
		if err != nil {
			return err
		}
		var page analyticsPage
		if err := json.Unmarshal(body, &page); err != nil {
			return fmt.Errorf("analytics page parse (schema drift?): %w", err)
		}
		for _, raw := range page.Data {
			var rec analyticsRecord
			if err := json.Unmarshal(raw, &rec); err != nil {
				log.Printf("[analytics] record skipped (schema drift?): %v", err)
				continue
			}
			if err := upsertAnalyticsRecord(ctx, pool, rec); err != nil {
				return err
			}
		}
		if !page.HasMore || page.NextPage == "" {
			return nil
		}
		params.Set("page", page.NextPage)
	}
}

func upsertAnalyticsRecord(ctx context.Context, pool *pgxpool.Pool, rec analyticsRecord) error {
	day, err := time.Parse("2006-01-02", rec.Date)
	if err != nil {
		log.Printf("[analytics] record with bad date %q skipped", rec.Date)
		return nil
	}
	actor := rec.APIActor
	if actor == "" {
		actor = rec.Actor
	}
	if actor == "" {
		actor = "unknown"
	}
	for _, mb := range rec.ModelBreakdown {
		costUsd := float64(mb.EstimatedCost.Amount) / 100 // API reports cents
		_, err := pool.Exec(ctx, `
			insert into cost_daily (day, api_key_name, model, tok_in, tok_out,
				tok_cache_read, tok_cache_create, sessions, est_cost_usd)
			values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
			on conflict (day, api_key_name, model) do update set
				tok_in = excluded.tok_in, tok_out = excluded.tok_out,
				tok_cache_read = excluded.tok_cache_read,
				tok_cache_create = excluded.tok_cache_create,
				sessions = excluded.sessions,
				est_cost_usd = excluded.est_cost_usd`,
			day, actor, mb.Model,
			int64(mb.Tokens.Input), int64(mb.Tokens.Output),
			int64(mb.Tokens.CacheRead), int64(mb.Tokens.CacheCreation),
			rec.CoreMetrics.NumSessions,
			strconv.FormatFloat(costUsd, 'f', 6, 64))
		if err != nil {
			return err
		}
	}
	return nil
}

type costReportPage struct {
	Data []struct {
		StartingAt string `json:"starting_at"`
		Results    []struct {
			Amount   flexFloat `json:"amount"` // dollars, decimal string
			Currency string    `json:"currency"`
		} `json:"results"`
	} `json:"data"`
	HasMore  bool   `json:"has_more"`
	NextPage string `json:"next_page"`
}

// RunCostReport ingests billing-accurate daily org totals for
// reconciliation, stored under the reserved key '__org_total'.
func RunCostReport(ctx context.Context, pool *pgxpool.Pool, baseURL, key string) error {
	params := url.Values{}
	params.Set("starting_at", time.Now().AddDate(0, 0, -30).UTC().Format(time.RFC3339))

	for {
		body, err := adminGet(ctx, baseURL, key, "/v1/organizations/cost_report", params)
		if err != nil {
			return err
		}
		var page costReportPage
		if err := json.Unmarshal(body, &page); err != nil {
			return fmt.Errorf("cost report parse (schema drift?): %w", err)
		}
		for _, bucket := range page.Data {
			day, err := time.Parse(time.RFC3339, bucket.StartingAt)
			if err != nil {
				log.Printf("[cost_report] bucket with bad starting_at %q skipped", bucket.StartingAt)
				continue
			}
			total := 0.0
			for _, r := range bucket.Results {
				total += float64(r.Amount)
			}
			if _, err := pool.Exec(ctx, `
				insert into cost_daily (day, api_key_name, model, billed_cost_usd)
				values ($1, '__org_total', '', $2)
				on conflict (day, api_key_name, model) do update set
					billed_cost_usd = excluded.billed_cost_usd`,
				day.Truncate(24*time.Hour), strconv.FormatFloat(total, 'f', 6, 64)); err != nil {
				return err
			}
		}
		if !page.HasMore || page.NextPage == "" {
			return nil
		}
		params.Set("page", page.NextPage)
	}
}
