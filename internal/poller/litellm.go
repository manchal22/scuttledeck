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

// LiteLLM gateway deployments have no Anthropic invoice to reconcile
// against — the gateway's own spend accounting is the billing truth. This
// poller ingests daily totals from LiteLLM's spend report into cost_daily
// under the reserved key '__litellm_total', feeding the same
// estimate-vs-billed reconciliation as the Anthropic cost report.
//
// LiteLLM's response shape varies across versions; parsing is tolerant:
// records missing a recognizable date or spend field are logged and skipped.

const litellmReservedKey = "__litellm_total"

// RunLiteLLMSpend pulls the last 30 days of daily spend from a LiteLLM
// instance (GET /global/spend/report) and upserts billed daily totals.
func RunLiteLLMSpend(ctx context.Context, pool *pgxpool.Pool, baseURL, key string) error {
	params := url.Values{}
	params.Set("start_date", time.Now().AddDate(0, 0, -30).UTC().Format("2006-01-02"))
	params.Set("end_date", time.Now().UTC().Format("2006-01-02"))

	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		baseURL+"/global/spend/report?"+params.Encode(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	res, err := (&http.Client{Timeout: 60 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 20<<20))
	if err != nil {
		return err
	}
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("litellm spend report: HTTP %d: %.200s", res.StatusCode, body)
	}

	var records []map[string]json.RawMessage
	if err := json.Unmarshal(body, &records); err != nil {
		return fmt.Errorf("litellm spend report parse (schema drift?): %w", err)
	}

	for _, rec := range records {
		day, okDay := litellmDate(rec)
		spend, okSpend := litellmSpend(rec)
		if !okDay || !okSpend {
			log.Printf("[litellm] record skipped (unrecognized shape): keys=%v", keysOf(rec))
			continue
		}
		if _, err := pool.Exec(ctx, `
			insert into cost_daily (day, api_key_name, model, billed_cost_usd)
			values ($1, $2, '', $3)
			on conflict (day, api_key_name, model) do update set
				billed_cost_usd = excluded.billed_cost_usd`,
			day, litellmReservedKey, strconv.FormatFloat(spend, 'f', 6, 64)); err != nil {
			return err
		}
	}
	return nil
}

// litellmDate finds a date field across known LiteLLM response variants.
func litellmDate(rec map[string]json.RawMessage) (time.Time, bool) {
	for _, k := range []string{"group_by_day", "date", "day", "startTime", "start_date"} {
		raw, ok := rec[k]
		if !ok {
			continue
		}
		var s string
		if json.Unmarshal(raw, &s) != nil {
			continue
		}
		for _, layout := range []string{"2006-01-02", time.RFC3339, "2006-01-02T15:04:05"} {
			if t, err := time.Parse(layout, s); err == nil {
				return t.Truncate(24 * time.Hour), true
			}
		}
	}
	return time.Time{}, false
}

// litellmSpend finds a spend field across known LiteLLM response variants.
func litellmSpend(rec map[string]json.RawMessage) (float64, bool) {
	for _, k := range []string{"total_spend", "spend", "total", "total_cost"} {
		raw, ok := rec[k]
		if !ok {
			continue
		}
		var f flexFloat
		if json.Unmarshal(raw, &f) == nil && float64(f) >= 0 {
			return float64(f), true
		}
	}
	return 0, false
}

func keysOf(m map[string]json.RawMessage) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
