// Package ghevents normalizes GitHub webhook payloads into repo/run rows.
// Parsing is deliberately tolerant: only consumed fields are declared,
// everything else passes through. Schema drift logs and skips — never crashes.
package ghevents

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/scuttledeck/scuttledeck/internal/correlate"
)

type actor struct {
	Login *string `json:"login"`
}

type pullRequestRef struct {
	Number *int `json:"number"`
}

type workflowRun struct {
	ID              *int64           `json:"id"`
	Name            *string          `json:"name"`
	Path            *string          `json:"path"`
	RunAttempt      *int             `json:"run_attempt"`
	Event           *string          `json:"event"`
	Status          *string          `json:"status"`
	Conclusion      *string          `json:"conclusion"`
	HTMLURL         *string          `json:"html_url"`
	HeadBranch      *string          `json:"head_branch"`
	HeadSHA         *string          `json:"head_sha"`
	RunStartedAt    *string          `json:"run_started_at"`
	UpdatedAt       *string          `json:"updated_at"`
	Actor           *actor           `json:"actor"`
	TriggeringActor *actor           `json:"triggering_actor"`
	PullRequests    []pullRequestRef `json:"pull_requests"`
}

type repository struct {
	ID            *int64  `json:"id"`
	FullName      *string `json:"full_name"`
	DefaultBranch *string `json:"default_branch"`
}

type installationRef struct {
	ID *int64 `json:"id"`
}

// WorkflowRunEvent is the subset of the workflow_run payload we consume.
type WorkflowRunEvent struct {
	Action       *string          `json:"action"`
	WorkflowRun  *workflowRun     `json:"workflow_run"`
	Repository   *repository      `json:"repository"`
	Installation *installationRef `json:"installation"`
}

// Validate mirrors the strictness of the old zod schema: the identifiers we
// cannot proceed without.
func (e *WorkflowRunEvent) Validate() error {
	switch {
	case e.Action == nil:
		return fmt.Errorf("missing action")
	case e.WorkflowRun == nil || e.WorkflowRun.ID == nil:
		return fmt.Errorf("missing workflow_run.id")
	case e.Repository == nil || e.Repository.ID == nil || e.Repository.FullName == nil:
		return fmt.Errorf("missing repository id/full_name")
	}
	return nil
}

func ParseWorkflowRunEvent(payload []byte) (*WorkflowRunEvent, error) {
	var evt WorkflowRunEvent
	if err := json.Unmarshal(payload, &evt); err != nil {
		return nil, err
	}
	if err := evt.Validate(); err != nil {
		return nil, err
	}
	return &evt, nil
}

func parseTime(s *string) *time.Time {
	if s == nil {
		return nil
	}
	t, err := time.Parse(time.RFC3339, *s)
	if err != nil {
		return nil
	}
	return &t
}

func deref[T any](p *T, fallback T) T {
	if p != nil {
		return *p
	}
	return fallback
}

// ProcessWorkflowRun upserts installation → repo → run, then lets the
// correlator claim any telemetry sessions already waiting for this run.
func ProcessWorkflowRun(ctx context.Context, pool *pgxpool.Pool, evt *WorkflowRunEvent) (int64, error) {
	fullName := *evt.Repository.FullName
	orgName := strings.SplitN(fullName, "/", 2)[0]

	var instID int64
	found := false
	if evt.Installation != nil && evt.Installation.ID != nil {
		err := pool.QueryRow(ctx,
			`select id from installation where github_install_id = $1`, *evt.Installation.ID).Scan(&instID)
		if err == nil {
			found = true
		} else if err != pgx.ErrNoRows {
			return 0, err
		}
	}
	if !found {
		err := pool.QueryRow(ctx, `select id from installation where org = $1`, orgName).Scan(&instID)
		if err == pgx.ErrNoRows {
			var ghInstall any
			if evt.Installation != nil && evt.Installation.ID != nil {
				ghInstall = *evt.Installation.ID
			}
			if err := pool.QueryRow(ctx,
				`insert into installation (org, github_install_id) values ($1, $2) returning id`,
				orgName, ghInstall).Scan(&instID); err != nil {
				return 0, err
			}
		} else if err != nil {
			return 0, err
		} else if evt.Installation != nil && evt.Installation.ID != nil {
			if _, err := pool.Exec(ctx,
				`update installation set github_install_id = $2 where id = $1 and github_install_id is null`,
				instID, *evt.Installation.ID); err != nil {
				return 0, err
			}
		}
	}

	var repoID int64
	if err := pool.QueryRow(ctx, `
		insert into repo (installation_id, gh_repo_id, full_name, default_branch)
		values ($1, $2, $3, $4)
		on conflict (gh_repo_id) do update set
			full_name = excluded.full_name,
			default_branch = coalesce(excluded.default_branch, repo.default_branch),
			updated_at = now()
		returning id`,
		instID, *evt.Repository.ID, fullName, evt.Repository.DefaultBranch).Scan(&repoID); err != nil {
		return 0, err
	}

	wr := evt.WorkflowRun
	runStartedAt := parseTime(wr.RunStartedAt)
	var completedAt *time.Time
	if deref(evt.Action, "") == "completed" {
		completedAt = parseTime(wr.UpdatedAt)
	}
	var durationS any
	if runStartedAt != nil && completedAt != nil {
		d := int(completedAt.Sub(*runStartedAt).Round(time.Second).Seconds())
		if d < 0 {
			d = 0
		}
		durationS = d
	}
	actorLogin := ""
	if wr.TriggeringActor != nil && wr.TriggeringActor.Login != nil {
		actorLogin = *wr.TriggeringActor.Login
	} else if wr.Actor != nil && wr.Actor.Login != nil {
		actorLogin = *wr.Actor.Login
	}
	var prNumber any
	if len(wr.PullRequests) > 0 && wr.PullRequests[0].Number != nil {
		prNumber = *wr.PullRequests[0].Number
	}

	var (
		runID        int64
		outStarted   *time.Time
		outCompleted *time.Time
	)
	if err := pool.QueryRow(ctx, `
		insert into run (repo_id, gh_run_id, gh_run_attempt, workflow_path, workflow_name,
			trigger_event, actor, pr_number, head_branch, head_sha, status, conclusion,
			html_url, run_started_at, completed_at, duration_s)
		values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
		on conflict (gh_run_id) do update set
			gh_run_attempt = excluded.gh_run_attempt,
			status = excluded.status,
			conclusion = coalesce(excluded.conclusion, run.conclusion),
			completed_at = coalesce(excluded.completed_at, run.completed_at),
			duration_s = coalesce(excluded.duration_s, run.duration_s),
			pr_number = coalesce(excluded.pr_number, run.pr_number),
			run_started_at = coalesce(excluded.run_started_at, run.run_started_at),
			updated_at = now()
		returning id, run_started_at, completed_at`,
		repoID, *wr.ID, deref(wr.RunAttempt, 1), wr.Path, wr.Name,
		wr.Event, nullIfEmpty(actorLogin), prNumber, wr.HeadBranch, wr.HeadSHA,
		deref(wr.Status, "unknown"), wr.Conclusion, wr.HTMLURL,
		runStartedAt, completedAt, durationS).Scan(&runID, &outStarted, &outCompleted); err != nil {
		return 0, err
	}

	return runID, correlate.CorrelateRunArrival(ctx, pool, correlate.RunArrival{
		ID:           runID,
		GhRunID:      *wr.ID,
		RepoFullName: fullName,
		RunStartedAt: outStarted,
		CompletedAt:  outCompleted,
	})
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
