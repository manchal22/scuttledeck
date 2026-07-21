// Package correlate is the heart of Scuttledeck: it joins OTel agent
// sessions to GitHub workflow runs. Exact matches come from the
// github.run_id resource attribute injected by scuttledeck/setup; the
// fallback is a repo+time heuristic, stored with a confidence flag. Both
// directions are handled so ingestion order never matters.
package correlate

import (
	"context"
	"fmt"
	"math"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/scuttledeck/scuttledeck/internal/otlp"
)

// How far a session's observed lifetime may sit outside a run's window and
// still be claimed heuristically. Generous: OTel batches ~60s, CI clocks drift.
const heuristicWindow = 10 * time.Minute

type aggregated struct {
	metric, attrType, model string
	value                   float64
	temporality             otlp.Temporality
}

// aggregatePoints collapses a batch per (metric, type, model):
// delta points add, cumulative points take the max.
func aggregatePoints(points []otlp.MetricPoint) []aggregated {
	order := []string{}
	byKey := map[string]*aggregated{}
	for _, p := range points {
		key := p.Metric + " " + p.AttrType + " " + p.Model
		if existing, ok := byKey[key]; ok {
			if p.Temporality == otlp.Delta {
				existing.value += p.Value
			} else {
				existing.value = math.Max(existing.value, p.Value)
			}
		} else {
			byKey[key] = &aggregated{p.Metric, p.AttrType, p.Model, p.Value, p.Temporality}
			order = append(order, key)
		}
	}
	out := make([]aggregated, 0, len(order))
	for _, k := range order {
		out = append(out, *byKey[k])
	}
	return out
}

// ApplyBatch ingests one OTLP resource batch: upsert sessions, fold points
// into the session_metric accumulator (idempotent for cumulative counters),
// recompute rollups, attempt correlation. Returns touched session ids.
func ApplyBatch(ctx context.Context, pool *pgxpool.Pool, batch otlp.Batch, source string) ([]string, error) {
	hints := otlp.ParseGithubHints(batch.ResourceAttrs)

	bySession := map[string][]otlp.MetricPoint{}
	var sessionOrder []string
	for _, p := range batch.Points {
		if _, ok := bySession[p.SessionID]; !ok {
			sessionOrder = append(sessionOrder, p.SessionID)
		}
		bySession[p.SessionID] = append(bySession[p.SessionID], p)
	}

	var repoName, ghRunID any
	if hints.RepoFullName != "" {
		repoName = hints.RepoFullName
	}
	if hints.GhRunID > 0 {
		ghRunID = hints.GhRunID
	}

	for _, sessionID := range sessionOrder {
		_, err := pool.Exec(ctx, `
			insert into agent_session (session_id, repo_full_name, gh_run_id_hint, resource_attrs, source)
			values ($1, $2, $3, $4, $5)
			on conflict (session_id) do update set
				last_seen_at = now(),
				repo_full_name = coalesce(agent_session.repo_full_name, excluded.repo_full_name),
				gh_run_id_hint = coalesce(agent_session.gh_run_id_hint, excluded.gh_run_id_hint)`,
			sessionID, repoName, ghRunID, batch.ResourceAttrs, source)
		if err != nil {
			return nil, fmt.Errorf("upsert session %s: %w", sessionID, err)
		}

		for _, p := range aggregatePoints(bySession[sessionID]) {
			conflict := `greatest(session_metric.value, excluded.value)`
			if p.temporality == otlp.Delta {
				conflict = `session_metric.value + excluded.value`
			}
			_, err := pool.Exec(ctx, `
				insert into session_metric (session_id, metric, attr_type, model, value)
				values ($1, $2, $3, $4, $5)
				on conflict (session_id, metric, attr_type, model) do update set
					value = `+conflict+`, updated_at = now()`,
				sessionID, p.metric, p.attrType, p.model, strconv.FormatFloat(p.value, 'f', -1, 64))
			if err != nil {
				return nil, fmt.Errorf("upsert metric for %s: %w", sessionID, err)
			}
		}

		if err := RollupSession(ctx, pool, sessionID); err != nil {
			return nil, err
		}
		if err := CorrelateSession(ctx, pool, sessionID); err != nil {
			return nil, err
		}
	}
	return sessionOrder, nil
}

// RollupSession recomputes agent_session totals from the accumulator.
func RollupSession(ctx context.Context, pool *pgxpool.Pool, sessionID string) error {
	rows, err := pool.Query(ctx,
		`select metric, attr_type, model, value from session_metric where session_id = $1`, sessionID)
	if err != nil {
		return err
	}
	defer rows.Close()

	var tokIn, tokOut, tokCacheRead, tokCacheCreate, cost float64
	hasCost := false
	model := ""
	modelBest := -1.0

	for rows.Next() {
		var metric, attrType, m, valueStr string
		if err := rows.Scan(&metric, &attrType, &m, &valueStr); err != nil {
			return err
		}
		value, _ := strconv.ParseFloat(valueStr, 64)
		switch metric {
		case otlp.MetricTokenUsage:
			switch attrType {
			case "input":
				tokIn += value
			case "output":
				tokOut += value
			case "cacheRead":
				tokCacheRead += value
			case "cacheCreation":
				tokCacheCreate += value
			}
			if m != "" && value > modelBest {
				modelBest = value
				model = m
			}
		case otlp.MetricCostUsage:
			cost += value
			hasCost = true
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}

	var costArg any
	if hasCost {
		costArg = strconv.FormatFloat(cost, 'f', 6, 64)
	}
	var modelArg any
	if model != "" {
		modelArg = model
	}
	_, err = pool.Exec(ctx, `
		update agent_session set
			tok_in = $2, tok_out = $3, tok_cache_read = $4, tok_cache_create = $5,
			cost_usd = $6, model = coalesce($7, model), last_seen_at = now()
		where session_id = $1`,
		sessionID, math.Round(tokIn), math.Round(tokOut), math.Round(tokCacheRead),
		math.Round(tokCacheCreate), costArg, modelArg)
	return err
}

// CorrelateSession is the session-side pass: exact on the run-id hint, else
// repo+time heuristic. If a hint names a run we haven't seen, we wait for
// the webhook — never guess when an exact answer is coming.
func CorrelateSession(ctx context.Context, pool *pgxpool.Pool, sessionID string) error {
	var (
		id           int64
		runID        *int64
		ghRunIDHint  *int64
		repoFullName *string
		firstSeen    time.Time
		lastSeen     time.Time
	)
	err := pool.QueryRow(ctx, `
		select id, run_id, gh_run_id_hint, repo_full_name, first_seen_at, last_seen_at
		from agent_session where session_id = $1`, sessionID).
		Scan(&id, &runID, &ghRunIDHint, &repoFullName, &firstSeen, &lastSeen)
	if err == pgx.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	if runID != nil {
		return nil
	}

	if ghRunIDHint != nil {
		var rid int64
		err := pool.QueryRow(ctx, `select id from run where gh_run_id = $1`, *ghRunIDHint).Scan(&rid)
		if err == pgx.ErrNoRows {
			return nil // hint present, run not arrived yet
		}
		if err != nil {
			return err
		}
		_, err = pool.Exec(ctx,
			`update agent_session set run_id = $2, confidence = 'exact' where id = $1`, id, rid)
		return err
	}

	if repoFullName == nil {
		return nil
	}
	var repoID int64
	err = pool.QueryRow(ctx, `select id from repo where full_name = $1`, *repoFullName).Scan(&repoID)
	if err == pgx.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}

	startedBefore := lastSeen.Add(heuristicWindow)
	completedAfter := firstSeen.Add(-heuristicWindow)
	var candidate int64
	err = pool.QueryRow(ctx, `
		select id from run
		where repo_id = $1
		  and run_started_at <= $2
		  and (completed_at is null or completed_at >= $3)
		order by run_started_at desc nulls last
		limit 1`, repoID, startedBefore, completedAfter).Scan(&candidate)
	if err == pgx.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	_, err = pool.Exec(ctx,
		`update agent_session set run_id = $2, confidence = 'heuristic' where id = $1`, id, candidate)
	return err
}

// RunArrival describes a freshly upserted run for the run-side pass.
type RunArrival struct {
	ID           int64
	GhRunID      int64
	RepoFullName string
	RunStartedAt *time.Time
	CompletedAt  *time.Time
}

// CorrelateRunArrival claims sessions whose hint names this run (upgrading
// heuristic matches to exact), then sweeps hintless unmatched sessions in
// the repo whose lifetime overlaps the run window.
func CorrelateRunArrival(ctx context.Context, pool *pgxpool.Pool, a RunArrival) error {
	_, err := pool.Exec(ctx, `
		update agent_session set run_id = $1, confidence = 'exact'
		where gh_run_id_hint = $2 and (run_id is null or confidence <> 'exact')`,
		a.ID, a.GhRunID)
	if err != nil {
		return err
	}

	if a.RunStartedAt == nil {
		return nil
	}
	windowStart := a.RunStartedAt.Add(-heuristicWindow)
	end := time.Now()
	if a.CompletedAt != nil {
		end = *a.CompletedAt
	}
	windowEnd := end.Add(heuristicWindow)

	_, err = pool.Exec(ctx, `
		update agent_session set run_id = $1, confidence = 'heuristic'
		where run_id is null and gh_run_id_hint is null
		  and repo_full_name = $2
		  and first_seen_at >= $3 and first_seen_at <= $4`,
		a.ID, a.RepoFullName, windowStart, windowEnd)
	return err
}
