// Demo/dev seed: a plausible mid-size org two weeks into adopting the
// action. Deterministic RNG so screenshots are reproducible. Refuses to run
// on a non-empty database.
package main

import (
	"context"
	"fmt"
	"log"
	"math"
	"math/rand"
	"os"
	"time"

	"github.com/scuttledeck/scuttledeck/internal/db"
)

type seedRepo struct {
	name         string
	hasAction    bool
	version      string
	triggers     []string
	wfName       string
	subscription bool
	activity     float64
}

var repos = []seedRepo{
	{"harborline/api-gateway", true, "v1.4.2", []string{"pull_request", "issue_comment"}, "Claude PR Review", false, 1.0},
	{"harborline/billing", true, "v1.4.2", []string{"issue_comment"}, "Claude Assistant", false, 0.75},
	{"harborline/web-app", true, "v1.2.0", []string{"pull_request"}, "Claude Review", false, 0.9},
	{"harborline/etl-pipelines", true, "v1.4.2", []string{"schedule", "workflow_dispatch"}, "Nightly Refactor Scout", true, 0.35},
	{"harborline/mobile", true, "v0.9.1", []string{"issue_comment"}, "Claude Helper", false, 0.45},
	{"harborline/infra-terraform", false, "", nil, "", false, 0},
	{"harborline/design-tokens", false, "", nil, "", false, 0},
	{"harborline/docs-site", false, "", nil, "", false, 0},
}

var models = []string{"claude-sonnet-5", "claude-sonnet-5", "claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"}
var actors = []string{"mira-chen", "dev-arjun", "sofia-lund", "jkowalski", "renovate[bot]"}

func main() {
	ctx := context.Background()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		log.Fatal("DATABASE_URL is required")
	}
	pool, err := db.Connect(ctx, url)
	if err != nil {
		log.Fatal(err)
	}
	if err := db.Migrate(ctx, pool); err != nil {
		log.Fatal(err)
	}

	var repoCount int
	if err := pool.QueryRow(ctx, `select count(*) from repo`).Scan(&repoCount); err != nil {
		log.Fatal(err)
	}
	if repoCount > 0 {
		log.Fatal("database is not empty — refusing to seed")
	}

	rng := rand.New(rand.NewSource(20260720))
	pick := func(list []string) string { return list[rng.Intn(len(list))] }

	var instID int64
	if err := pool.QueryRow(ctx,
		`insert into installation (org, github_install_id) values ('harborline', 71234501) returning id`,
	).Scan(&instID); err != nil {
		log.Fatal(err)
	}

	ghRepoID := int64(900_100_000)
	ghRunID := int64(16_200_000_000)
	sessionSeq := 0
	day := 24 * time.Hour
	runsTotal, sessionsTotal := 0, 0

	for _, r := range repos {
		ghRepoID += 17
		var repoID int64
		if err := pool.QueryRow(ctx, `
			insert into repo (installation_id, gh_repo_id, full_name, default_branch, has_action)
			values ($1, $2, $3, 'main', $4) returning id`,
			instID, ghRepoID, r.name, r.hasAction).Scan(&repoID); err != nil {
			log.Fatal(err)
		}
		if !r.hasAction {
			continue
		}

		triggersJSON := "["
		for i, t := range r.triggers {
			if i > 0 {
				triggersJSON += ","
			}
			triggersJSON += fmt.Sprintf("%q", t)
		}
		triggersJSON += "]"
		if _, err := pool.Exec(ctx, `
			insert into workflow (repo_id, path, name, action_ref, action_version, triggers, model_config, last_scanned_at)
			values ($1, '.github/workflows/claude.yml', $2, $3, $4, $5, '{"model":"claude-sonnet-5"}', now())`,
			repoID, r.wfName, "anthropics/claude-code-action@"+r.version, r.version, triggersJSON); err != nil {
			log.Fatal(err)
		}

		for d := 13; d >= 0; d-- {
			dayStart := time.Now().Add(-time.Duration(d) * day)
			weekdayFactor := 1.0
			if wd := dayStart.Weekday(); wd == time.Saturday || wd == time.Sunday {
				weekdayFactor = 0.25
			}
			runsToday := int(math.Round((2 + rng.Float64()*6) * r.activity * weekdayFactor))
			for i := 0; i < runsToday; i++ {
				ghRunID += int64(1 + rng.Intn(999))
				startedAt := dayStart.Add(-time.Duration(rng.Float64() * 10 * float64(time.Hour)))
				durationS := 90 + rng.Intn(600)
				completedAt := startedAt.Add(time.Duration(durationS) * time.Second)
				stillRunning := d == 0 && i == runsToday-1 && rng.Float64() < 0.5

				status, conclusion := "completed", ""
				switch roll := rng.Float64(); {
				case stillRunning:
					status = "in_progress"
				case roll < 0.82:
					conclusion = "success"
				case roll < 0.94:
					conclusion = "failure"
				default:
					conclusion = "cancelled"
				}
				var prNumber any
				if rng.Float64() < 0.72 {
					prNumber = 100 + rng.Intn(400)
				}
				headBranch := "main"
				if prNumber != nil {
					headBranch = fmt.Sprintf("feat/change-%d", prNumber)
				}
				var completedArg, durationArg any
				if !stillRunning {
					completedArg, durationArg = completedAt, durationS
				}

				var runID int64
				if err := pool.QueryRow(ctx, `
					insert into run (repo_id, gh_run_id, workflow_path, workflow_name, trigger_event,
						actor, pr_number, head_branch, status, conclusion, html_url,
						run_started_at, completed_at, duration_s)
					values ($1,$2,'.github/workflows/claude.yml',$3,$4,$5,$6,$7,$8,nullif($9,''),$10,$11,$12,$13)
					returning id`,
					repoID, ghRunID, r.wfName, pick(r.triggers), pick(actors), prNumber, headBranch,
					status, conclusion,
					fmt.Sprintf("https://github.com/%s/actions/runs/%d", r.name, ghRunID),
					startedAt, completedArg, durationArg).Scan(&runID); err != nil {
					log.Fatal(err)
				}
				runsTotal++

				if rng.Float64() < 0.9 { // ~90% of runs shipped telemetry
					sessionSeq++
					model := pick(models)
					tokIn := 8_000 + rng.Intn(90_000)
					tokOut := 1_200 + rng.Intn(18_000)
					cacheRead := int(float64(tokIn) * (2 + rng.Float64()*6))
					cacheCreate := int(float64(tokIn) * (0.1 + rng.Float64()*0.4))
					var cost any
					if !r.subscription {
						cost = fmt.Sprintf("%.6f",
							float64(tokIn)/1e6*3+float64(tokOut)/1e6*15+
								float64(cacheRead)/1e6*0.3+float64(cacheCreate)/1e6*3.75)
					}
					confidence := "exact"
					var hint any = ghRunID
					if rng.Float64() >= 0.88 {
						confidence, hint = "heuristic", nil
					}
					lastSeen := completedAt
					if stillRunning {
						lastSeen = time.Now()
					}
					if _, err := pool.Exec(ctx, `
						insert into agent_session (run_id, session_id, repo_full_name, gh_run_id_hint,
							model, tok_in, tok_out, tok_cache_read, tok_cache_create, cost_usd,
							source, confidence, first_seen_at, last_seen_at)
						values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'otel',$11,$12,$13)`,
						runID, fmt.Sprintf("seed-%04d-%d", sessionSeq, ghRunID), r.name, hint,
						model, tokIn, tokOut, cacheRead, cacheCreate, cost,
						confidence, startedAt, lastSeen); err != nil {
						log.Fatal(err)
					}
					sessionsTotal++
				}
			}
		}
	}

	// one orphan session: telemetry arrived, webhook never did
	orphanAt := time.Now().Add(-26 * time.Hour)
	if _, err := pool.Exec(ctx, `
		insert into agent_session (session_id, repo_full_name, model, tok_in, tok_out,
			tok_cache_read, tok_cache_create, cost_usd, source, confidence, first_seen_at, last_seen_at)
		values ('seed-orphan-0001','harborline/api-gateway','claude-sonnet-5',
			15400,3100,88000,4100,'0.212400','otel','unmatched',$1,$2)`,
		orphanAt, orphanAt.Add(5*time.Minute)); err != nil {
		log.Fatal(err)
	}

	fmt.Printf("seeded: %d repos, %d runs, %d sessions\n", len(repos), runsTotal, sessionsTotal+1)
	pool.Close()
}
