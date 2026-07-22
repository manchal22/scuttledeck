package ghevents

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

type prUser struct {
	Login *string `json:"login"`
}

type prPayload struct {
	Number    *int    `json:"number"`
	Title     *string `json:"title"`
	State     *string `json:"state"`
	Merged    *bool   `json:"merged"`
	CreatedAt *string `json:"created_at"`
	ClosedAt  *string `json:"closed_at"`
	MergedAt  *string `json:"merged_at"`
	User      *prUser `json:"user"`
	Head      *struct {
		Ref *string `json:"ref"`
	} `json:"head"`
}

// PullRequestEvent is the consumed subset of the pull_request payload.
type PullRequestEvent struct {
	Action      *string     `json:"action"`
	PullRequest *prPayload  `json:"pull_request"`
	Repository  *repository `json:"repository"`
}

func ParsePullRequestEvent(payload []byte) (*PullRequestEvent, error) {
	var evt PullRequestEvent
	if err := json.Unmarshal(payload, &evt); err != nil {
		return nil, err
	}
	if evt.PullRequest == nil || evt.PullRequest.Number == nil ||
		evt.Repository == nil || evt.Repository.ID == nil || evt.Repository.FullName == nil {
		return nil, fmt.Errorf("missing pull_request.number or repository")
	}
	return &evt, nil
}

// ProcessPullRequest upserts the PR lifecycle row — author, open/closed
// state, and whether it merged. This powers reviewed-vs-merged metrics.
func ProcessPullRequest(ctx context.Context, pool *pgxpool.Pool, evt *PullRequestEvent) error {
	repoID, err := upsertRepoRef(ctx, pool, evt.Repository)
	if err != nil {
		return err
	}
	pr := evt.PullRequest
	var author, headBranch *string
	if pr.User != nil {
		author = pr.User.Login
	}
	if pr.Head != nil {
		headBranch = pr.Head.Ref
	}
	_, err = pool.Exec(ctx, `
		insert into pull_request (repo_id, pr_number, author, title, state, merged,
			head_branch, opened_at, closed_at, merged_at)
		values ($1,$2,$3,$4,coalesce($5,'open'),coalesce($6,false),$7,$8,$9,$10)
		on conflict (repo_id, pr_number) do update set
			author = coalesce(excluded.author, pull_request.author),
			title = coalesce(excluded.title, pull_request.title),
			state = excluded.state,
			merged = pull_request.merged or excluded.merged,
			head_branch = coalesce(excluded.head_branch, pull_request.head_branch),
			opened_at = coalesce(pull_request.opened_at, excluded.opened_at),
			closed_at = coalesce(excluded.closed_at, pull_request.closed_at),
			merged_at = coalesce(excluded.merged_at, pull_request.merged_at),
			updated_at = now()`,
		repoID, *pr.Number, author, pr.Title, pr.State, pr.Merged, headBranch,
		parseTime(pr.CreatedAt), parseTime(pr.ClosedAt), parseTime(pr.MergedAt))
	return err
}

// upsertRepoRef ensures a repo row exists for webhook events that arrive
// before any workflow_run (or discovery scan) created one.
func upsertRepoRef(ctx context.Context, pool *pgxpool.Pool, r *repository) (int64, error) {
	orgName := strings.SplitN(*r.FullName, "/", 2)[0]
	var instID int64
	err := pool.QueryRow(ctx, `select id from installation where org = $1`, orgName).Scan(&instID)
	if err != nil {
		if err2 := pool.QueryRow(ctx,
			`insert into installation (org) values ($1) on conflict (org) do update set org = excluded.org returning id`,
			orgName).Scan(&instID); err2 != nil {
			return 0, err2
		}
	}
	var repoID int64
	err = pool.QueryRow(ctx, `
		insert into repo (installation_id, gh_repo_id, full_name, default_branch)
		values ($1, $2, $3, $4)
		on conflict (gh_repo_id) do update set
			full_name = excluded.full_name, updated_at = now()
		returning id`, instID, *r.ID, *r.FullName, r.DefaultBranch).Scan(&repoID)
	return repoID, err
}

// PushEvent detects workflow-file changes so discovery can rescan just-in-time.
type PushEvent struct {
	Repository *repository `json:"repository"`
	Commits    []struct {
		Added    []string `json:"added"`
		Modified []string `json:"modified"`
		Removed  []string `json:"removed"`
	} `json:"commits"`
}

// TouchesWorkflows reports whether any commit in the push changed a file
// under .github/workflows/.
func (p *PushEvent) TouchesWorkflows() bool {
	for _, c := range p.Commits {
		for _, files := range [][]string{c.Added, c.Modified, c.Removed} {
			for _, f := range files {
				if strings.HasPrefix(f, ".github/workflows/") {
					return true
				}
			}
		}
	}
	return false
}
