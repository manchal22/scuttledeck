// Package discovery finds workflows using claude-code-action across an org.
// GitHub has no API for "repos using action X", so: list repos → list
// .github/workflows files → fetch YAML via the contents API → parse for the
// action (any owner/fork/ref). ETag conditional requests keep repeat scans
// nearly free against the 5k/hr limit.
package discovery

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"gopkg.in/yaml.v3"
)

var actionRepoNames = map[string]bool{
	"claude-code-action":      true,
	"claude-code-base-action": true,
}

// UsesClaudeCodeAction reports whether a `uses:` value points at the action
// (any owner, any ref).
func UsesClaudeCodeAction(uses string) bool {
	pathPart := strings.SplitN(uses, "@", 2)[0]
	for _, seg := range strings.Split(pathPart, "/") {
		if actionRepoNames[strings.ToLower(seg)] {
			return true
		}
	}
	return false
}

type WorkflowHit struct {
	Path          string
	Name          string
	ActionRef     string
	ActionVersion string
	Triggers      []string
	ModelConfig   map[string]any
}

type RepoScanResult struct {
	GhRepoID      int64
	FullName      string
	DefaultBranch string
	Hits          []WorkflowHit
}

func extractTriggers(on any) []string {
	switch v := on.(type) {
	case string:
		return []string{v}
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			out = append(out, fmt.Sprint(item))
		}
		return out
	case map[string]any:
		out := make([]string, 0, len(v))
		for k := range v {
			out = append(out, k)
		}
		return out
	}
	return nil
}

// ParseWorkflowFile returns a hit when the workflow uses the action, else nil.
func ParseWorkflowFile(path, content string) *WorkflowHit {
	var root map[string]any
	if err := yaml.Unmarshal([]byte(content), &root); err != nil {
		return nil
	}
	jobs, _ := root["jobs"].(map[string]any)
	if jobs == nil {
		return nil
	}
	for _, jobAny := range jobs {
		job, _ := jobAny.(map[string]any)
		if job == nil {
			continue
		}
		steps, _ := job["steps"].([]any)
		for _, stepAny := range steps {
			step, _ := stepAny.(map[string]any)
			if step == nil {
				continue
			}
			uses, _ := step["uses"].(string)
			if uses == "" || !UsesClaudeCodeAction(uses) {
				continue
			}

			version := ""
			if at := strings.Index(uses, "@"); at >= 0 {
				version = uses[at+1:]
			}
			modelConfig := map[string]any{}
			if with, _ := step["with"].(map[string]any); with != nil {
				for k, v := range with {
					if strings.Contains(strings.ToLower(k), "model") {
						modelConfig[k] = v
					}
				}
			}
			if len(modelConfig) == 0 {
				modelConfig = nil
			}
			// YAML 1.1 parses bare `on` as boolean true; yaml.v3 maps it to "true".
			on := root["on"]
			if on == nil {
				on = root["true"]
			}
			name, _ := root["name"].(string)
			return &WorkflowHit{
				Path:          path,
				Name:          name,
				ActionRef:     uses,
				ActionVersion: version,
				Triggers:      extractTriggers(on),
				ModelConfig:   modelConfig,
			}
		}
	}
	return nil
}

// Client is the minimal GitHub surface the scanner needs — injectable for tests.
type Client interface {
	ListRepos(ctx context.Context, org string) ([]RepoRef, error)
	ListWorkflowPaths(ctx context.Context, owner, repo string) ([]string, error)
	GetFileContent(ctx context.Context, owner, repo, path string) (string, error)
}

type RepoRef struct {
	ID            int64
	FullName      string
	DefaultBranch string
}

// ScanOrg walks every repo and returns the discovered inventory.
func ScanOrg(ctx context.Context, c Client, org string) ([]RepoScanResult, error) {
	repos, err := c.ListRepos(ctx, org)
	if err != nil {
		return nil, err
	}
	results := make([]RepoScanResult, 0, len(repos))
	for _, r := range repos {
		parts := strings.SplitN(r.FullName, "/", 2)
		owner, repoName := parts[0], parts[len(parts)-1]
		paths, err := c.ListWorkflowPaths(ctx, owner, repoName)
		if err != nil {
			return nil, err
		}
		var hits []WorkflowHit
		for _, p := range paths {
			content, err := c.GetFileContent(ctx, owner, repoName, p)
			if err != nil {
				return nil, err
			}
			if content == "" {
				continue
			}
			if hit := ParseWorkflowFile(p, content); hit != nil {
				hits = append(hits, *hit)
			}
		}
		results = append(results, RepoScanResult{
			GhRepoID:      r.ID,
			FullName:      r.FullName,
			DefaultBranch: r.DefaultBranch,
			Hits:          hits,
		})
	}
	return results, nil
}

// PersistScan upserts repos, flags has_action, and upserts workflows.
func PersistScan(ctx context.Context, pool *pgxpool.Pool, installationID int64, results []RepoScanResult) error {
	for _, r := range results {
		var repoID int64
		if err := pool.QueryRow(ctx, `
			insert into repo (installation_id, gh_repo_id, full_name, default_branch, has_action)
			values ($1, $2, $3, nullif($4, ''), $5)
			on conflict (gh_repo_id) do update set
				full_name = excluded.full_name,
				default_branch = coalesce(excluded.default_branch, repo.default_branch),
				has_action = excluded.has_action,
				updated_at = now()
			returning id`,
			installationID, r.GhRepoID, r.FullName, r.DefaultBranch, len(r.Hits) > 0).Scan(&repoID); err != nil {
			return err
		}
		for _, hit := range r.Hits {
			var modelConfig any
			if hit.ModelConfig != nil {
				b, _ := json.Marshal(hit.ModelConfig)
				modelConfig = b
			}
			triggers, _ := json.Marshal(hit.Triggers)
			if _, err := pool.Exec(ctx, `
				insert into workflow (repo_id, path, name, action_ref, action_version, triggers, model_config, last_scanned_at)
				values ($1, $2, nullif($3,''), $4, nullif($5,''), $6, $7, now())
				on conflict (repo_id, path) do update set
					name = excluded.name, action_ref = excluded.action_ref,
					action_version = excluded.action_version, triggers = excluded.triggers,
					model_config = excluded.model_config, last_scanned_at = now()`,
				repoID, hit.Path, hit.Name, hit.ActionRef, hit.ActionVersion, triggers, modelConfig); err != nil {
				return err
			}
		}
	}
	return nil
}

// restClient implements Client against api.github.com with an ETag cache.
type restClient struct {
	token  string
	http   *http.Client
	mu     sync.Mutex
	etags  map[string]string
	bodies map[string][]byte
}

func NewRESTClient(token string) Client {
	return &restClient{
		token:  token,
		http:   &http.Client{Timeout: 30 * time.Second},
		etags:  map[string]string{},
		bodies: map[string][]byte{},
	}
}

func (c *restClient) get(ctx context.Context, url string) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	c.mu.Lock()
	if etag := c.etags[url]; etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	c.mu.Unlock()

	res, err := c.http.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()

	if res.StatusCode == http.StatusNotModified {
		c.mu.Lock()
		body := c.bodies[url]
		c.mu.Unlock()
		return http.StatusOK, body, nil
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return 0, nil, err
	}
	if res.StatusCode == http.StatusOK {
		if etag := res.Header.Get("ETag"); etag != "" {
			c.mu.Lock()
			c.etags[url], c.bodies[url] = etag, body
			c.mu.Unlock()
		}
	}
	return res.StatusCode, body, nil
}

var linkNextRe = regexp.MustCompile(`<([^>]+)>;\s*rel="next"`)

func (c *restClient) ListRepos(ctx context.Context, org string) ([]RepoRef, error) {
	var out []RepoRef
	// Works for both orgs and user accounts.
	for _, base := range []string{
		fmt.Sprintf("https://api.github.com/orgs/%s/repos?per_page=100", org),
		fmt.Sprintf("https://api.github.com/users/%s/repos?per_page=100", org),
	} {
		url := base
		for url != "" {
			status, body, err := c.get(ctx, url)
			if err != nil {
				return nil, err
			}
			if status == http.StatusNotFound {
				break // try the next base
			}
			if status != http.StatusOK {
				return nil, fmt.Errorf("GET %s: HTTP %d", url, status)
			}
			var page []struct {
				ID            int64  `json:"id"`
				FullName      string `json:"full_name"`
				DefaultBranch string `json:"default_branch"`
			}
			if err := json.Unmarshal(body, &page); err != nil {
				return nil, err
			}
			for _, r := range page {
				out = append(out, RepoRef{ID: r.ID, FullName: r.FullName, DefaultBranch: r.DefaultBranch})
			}
			url = ""
			if len(page) == 100 {
				// naive next-page: rely on Link header when present
				if m := linkNextRe.FindStringSubmatch(base); m != nil {
					url = m[1]
				}
			}
		}
		if len(out) > 0 {
			return out, nil
		}
	}
	return out, nil
}

func (c *restClient) ListWorkflowPaths(ctx context.Context, owner, repo string) ([]string, error) {
	url := fmt.Sprintf("https://api.github.com/repos/%s/%s/contents/.github/workflows", owner, repo)
	status, body, err := c.get(ctx, url)
	if err != nil {
		return nil, err
	}
	if status == http.StatusNotFound {
		return nil, nil
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("GET %s: HTTP %d", url, status)
	}
	var files []struct {
		Type string `json:"type"`
		Name string `json:"name"`
		Path string `json:"path"`
	}
	if err := json.Unmarshal(body, &files); err != nil {
		return nil, nil // single file object, not a workflows dir
	}
	var out []string
	for _, f := range files {
		if f.Type == "file" && (strings.HasSuffix(f.Name, ".yml") || strings.HasSuffix(f.Name, ".yaml")) {
			out = append(out, f.Path)
		}
	}
	return out, nil
}

func (c *restClient) GetFileContent(ctx context.Context, owner, repo, path string) (string, error) {
	url := fmt.Sprintf("https://api.github.com/repos/%s/%s/contents/%s", owner, repo, path)
	status, body, err := c.get(ctx, url)
	if err != nil {
		return "", err
	}
	if status == http.StatusNotFound {
		return "", nil
	}
	if status != http.StatusOK {
		return "", fmt.Errorf("GET %s: HTTP %d", url, status)
	}
	var file struct {
		Type    string `json:"type"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal(body, &file); err != nil || file.Type != "file" {
		return "", nil
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(file.Content, "\n", ""))
	if err != nil {
		return "", nil
	}
	return string(decoded), nil
}
