package poller

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/scuttledeck/scuttledeck/internal/githubapp"
)

// GitHub never retries failed webhook deliveries on its own — an ingest
// outage would silently lose events for up to 30 days. This sweeper lists
// recent deliveries on every hook pointing at us, and redelivers any that
// GitHub marked failed and that never reached the webhook_delivery table
// (redeliveries keep their GUID, so a success self-limits the sweep).

const redeliveryLookback = 48 * time.Hour

type ghHook struct {
	ID     int64 `json:"id"`
	Config struct {
		URL string `json:"url"`
	} `json:"config"`
}

type ghDelivery struct {
	ID          int64     `json:"id"`
	GUID        string    `json:"guid"`
	DeliveredAt time.Time `json:"delivered_at"`
	StatusCode  int       `json:"status_code"`
	Event       string    `json:"event"`
	Redelivery  bool      `json:"redelivery"`
}

type ghAPI struct {
	baseURL string
	token   string
	http    *http.Client
}

func (g *ghAPI) do(ctx context.Context, method, path string, out any) (int, error) {
	req, err := http.NewRequestWithContext(ctx, method, g.baseURL+path, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Authorization", "Bearer "+g.token)
	res, err := g.http.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 10<<20))
	if res.StatusCode < 300 && out != nil {
		if err := json.Unmarshal(body, out); err != nil {
			return res.StatusCode, fmt.Errorf("%s %s: parse: %w", method, path, err)
		}
	}
	return res.StatusCode, nil
}

// RunRedelivery sweeps hooks that point at this Scuttledeck instance and
// redelivers failed deliveries that were never received. With a PAT it
// walks org/repo hooks; with a GitHub App it sweeps the app's own webhook
// via /app/hook/deliveries (JWT auth).
func RunRedelivery(ctx context.Context, pool *pgxpool.Pool, cfg Config) error {
	baseURL := cfg.GithubAPIBaseURL
	if baseURL == "" {
		baseURL = "https://api.github.com"
	}
	if cfg.GithubToken == "" {
		app, err := githubapp.Load(ctx, pool)
		if err != nil || app == nil {
			return err
		}
		jwt, err := app.JWT()
		if err != nil {
			return err
		}
		gh := &ghAPI{baseURL: baseURL, token: jwt, http: &http.Client{Timeout: 30 * time.Second}}
		n, err := sweepDeliveries(ctx, pool, gh, "/app/hook/deliveries?per_page=100", "/app/hook/deliveries/%d/attempts")
		if err != nil {
			return err
		}
		if n > 0 {
			log.Printf("[redeliver] requested %d app-webhook redeliveries", n)
		}
		return nil
	}
	gh := &ghAPI{baseURL: baseURL, token: cfg.GithubToken, http: &http.Client{Timeout: 30 * time.Second}}

	// hook scopes: each installation's org hooks plus hooks on tracked repos
	scopes := map[string]bool{} // API path prefix, e.g. "orgs/acme" or "repos/acme/api"
	orgRows, err := pool.Query(ctx, `select org from installation`)
	if err != nil {
		return err
	}
	for orgRows.Next() {
		var org string
		if err := orgRows.Scan(&org); err != nil {
			orgRows.Close()
			return err
		}
		scopes["orgs/"+org] = true
	}
	orgRows.Close()

	repoRows, err := pool.Query(ctx,
		`select full_name from repo order by has_action desc, id limit 100`)
	if err != nil {
		return err
	}
	for repoRows.Next() {
		var full string
		if err := repoRows.Scan(&full); err != nil {
			repoRows.Close()
			return err
		}
		scopes["repos/"+full] = true
	}
	repoRows.Close()

	redelivered := 0
	for scope := range scopes {
		var hooks []ghHook
		status, err := gh.do(ctx, http.MethodGet, "/"+scope+"/hooks", &hooks)
		if err != nil {
			log.Printf("[redeliver] %s: %v", scope, err)
			continue
		}
		if status == http.StatusNotFound || status == http.StatusForbidden {
			continue // scope has no visible hooks (e.g. org endpoint on a user account)
		}
		for _, hook := range hooks {
			if !strings.Contains(hook.Config.URL, "/webhooks/github") {
				continue // someone else's hook
			}
			n, err := sweepHook(ctx, pool, gh, scope, hook.ID)
			if err != nil {
				log.Printf("[redeliver] %s hook %d: %v", scope, hook.ID, err)
				continue
			}
			redelivered += n
		}
	}
	if redelivered > 0 {
		log.Printf("[redeliver] requested %d redeliveries", redelivered)
	}
	return nil
}

func sweepHook(ctx context.Context, pool *pgxpool.Pool, gh *ghAPI, scope string, hookID int64) (int, error) {
	return sweepDeliveries(ctx, pool, gh,
		fmt.Sprintf("/%s/hooks/%d/deliveries?per_page=100", scope, hookID),
		"/"+scope+fmt.Sprintf("/hooks/%d", hookID)+"/deliveries/%d/attempts")
}

// sweepDeliveries lists deliveries at listPath and redelivers lost ones via
// the printf-style attemptPathFmt (one %d: the delivery id).
func sweepDeliveries(ctx context.Context, pool *pgxpool.Pool, gh *ghAPI, listPath, attemptPathFmt string) (int, error) {
	var deliveries []ghDelivery
	status, err := gh.do(ctx, http.MethodGet, listPath, &deliveries)
	if err != nil || status >= 300 {
		return 0, fmt.Errorf("list deliveries: HTTP %d %v", status, err)
	}

	cutoff := time.Now().Add(-redeliveryLookback)
	// A GUID may appear more than once (original + redeliveries): only act
	// when no attempt of that GUID succeeded.
	succeeded := map[string]bool{}
	latestFailed := map[string]ghDelivery{}
	for _, d := range deliveries {
		if d.DeliveredAt.Before(cutoff) {
			continue
		}
		if d.StatusCode >= 200 && d.StatusCode < 300 {
			succeeded[d.GUID] = true
			continue
		}
		if prev, ok := latestFailed[d.GUID]; !ok || d.DeliveredAt.After(prev.DeliveredAt) {
			latestFailed[d.GUID] = d
		}
	}

	count := 0
	for guid, d := range latestFailed {
		if succeeded[guid] {
			continue
		}
		// Skip deliveries that arrived despite a logged failure (e.g. response timeout after processing).
		var seen bool
		if err := pool.QueryRow(ctx,
			`select exists (select 1 from webhook_delivery where delivery_id = $1)`, guid).Scan(&seen); err != nil {
			return count, err
		}
		if seen {
			continue
		}
		status, err := gh.do(ctx, http.MethodPost, fmt.Sprintf(attemptPathFmt, d.ID), nil)
		if err != nil || status >= 300 {
			log.Printf("[redeliver] delivery %s (%s): HTTP %d %v", guid, d.Event, status, err)
			continue
		}
		count++
	}
	return count, nil
}
