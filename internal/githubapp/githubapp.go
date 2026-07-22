// Package githubapp implements the GitHub App integration: the manifest
// that creates the app in two clicks, the code→credentials conversion, and
// short-lived installation tokens that replace long-lived PATs for the
// discovery and redelivery pollers.
package githubapp

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// App is a stored GitHub App credential set, created via the manifest flow.
type App struct {
	AppID         int64
	Slug          string
	Owner         string
	PEM           string
	WebhookSecret string
	HTMLURL       string
}

// BuildManifest returns the app manifest GitHub's create form consumes.
// Permissions are read-only by construction — the platform enforces what
// the docs promise.
func BuildManifest(externalURL, org string) map[string]any {
	name := "scuttledeck-" + org
	if len(name) > 34 { // GitHub app-name limit
		name = name[:34]
	}
	return map[string]any{
		"name":         name,
		"url":          "https://github.com/manchal22/scuttledeck",
		"description":  "Fleet monitoring for the Claude Code GitHub Action — read-only.",
		"public":       false,
		"redirect_url": externalURL + "/setup/github/callback",
		"hook_attributes": map[string]any{
			"url":    externalURL + "/webhooks/github",
			"active": true,
		},
		"default_permissions": map[string]string{
			"actions":       "read",
			"contents":      "read",
			"pull_requests": "read",
			"metadata":      "read",
		},
		"default_events": []string{
			"workflow_run",
			"pull_request",
			"push",
			"installation_repositories",
		},
	}
}

// ExchangeCode converts a one-time manifest code into app credentials.
func ExchangeCode(ctx context.Context, apiBase, code string) (*App, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		apiBase+"/app-manifests/"+code+"/conversions", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	res, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("manifest conversion: HTTP %d: %.300s", res.StatusCode, body)
	}
	var out struct {
		ID            int64  `json:"id"`
		Slug          string `json:"slug"`
		PEM           string `json:"pem"`
		WebhookSecret string `json:"webhook_secret"`
		HTMLURL       string `json:"html_url"`
		Owner         struct {
			Login string `json:"login"`
		} `json:"owner"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	if out.ID == 0 || out.PEM == "" || out.WebhookSecret == "" {
		return nil, fmt.Errorf("manifest conversion returned incomplete credentials")
	}
	return &App{
		AppID:         out.ID,
		Slug:          out.Slug,
		Owner:         out.Owner.Login,
		PEM:           out.PEM,
		WebhookSecret: out.WebhookSecret,
		HTMLURL:       out.HTMLURL,
	}, nil
}

// Save persists the app; a Scuttledeck instance holds at most a handful
// (typically one), the newest winning for setup purposes.
func Save(ctx context.Context, pool *pgxpool.Pool, a *App) error {
	_, err := pool.Exec(ctx, `
		insert into github_app (app_id, slug, owner, pem, webhook_secret, html_url)
		values ($1, $2, $3, $4, $5, $6)`,
		a.AppID, a.Slug, a.Owner, a.PEM, a.WebhookSecret, a.HTMLURL)
	return err
}

// Load returns the most recently created app, or nil when none exists.
func Load(ctx context.Context, pool *pgxpool.Pool) (*App, error) {
	var a App
	err := pool.QueryRow(ctx, `
		select app_id, coalesce(slug,''), coalesce(owner,''), pem, webhook_secret, coalesce(html_url,'')
		from github_app order by id desc limit 1`).
		Scan(&a.AppID, &a.Slug, &a.Owner, &a.PEM, &a.WebhookSecret, &a.HTMLURL)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &a, nil
}

// WebhookSecrets returns every stored app webhook secret, for signature
// verification alongside the env-configured secret.
func WebhookSecrets(ctx context.Context, pool *pgxpool.Pool) ([]string, error) {
	rows, err := pool.Query(ctx, `select webhook_secret from github_app`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// JWT mints the app-level JWT (RS256, ≤10 min) used for /app/* endpoints.
func (a *App) JWT() (string, error) {
	block, _ := pem.Decode([]byte(a.PEM))
	if block == nil {
		return "", fmt.Errorf("app private key: no PEM block")
	}
	var key *rsa.PrivateKey
	if k, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		key = k
	} else if k8, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		var ok bool
		if key, ok = k8.(*rsa.PrivateKey); !ok {
			return "", fmt.Errorf("app private key: not RSA")
		}
	} else {
		return "", fmt.Errorf("app private key: unparseable")
	}

	now := time.Now()
	header := b64url([]byte(`{"alg":"RS256","typ":"JWT"}`))
	payload, _ := json.Marshal(map[string]any{
		"iat": now.Add(-60 * time.Second).Unix(),
		"exp": now.Add(9 * time.Minute).Unix(),
		"iss": a.AppID,
	})
	signing := header + "." + b64url(payload)
	digest := sha256.Sum256([]byte(signing))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	return signing + "." + b64url(sig), nil
}

// InstallationAuth is a short-lived token scoped to one installation.
type InstallationAuth struct {
	InstallID int64
	Org       string
	Token     string
}

// InstallationTokens lists the app's installations and mints an access
// token for each — the PAT replacement for discovery and redelivery.
func (a *App) InstallationTokens(ctx context.Context, apiBase string) ([]InstallationAuth, error) {
	jwt, err := a.JWT()
	if err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: 30 * time.Second}

	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, apiBase+"/app/installations?per_page=100", nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Authorization", "Bearer "+jwt)
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 10<<20))
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("list installations: HTTP %d: %.200s", res.StatusCode, body)
	}
	var installs []struct {
		ID      int64 `json:"id"`
		Account struct {
			Login string `json:"login"`
		} `json:"account"`
	}
	if err := json.Unmarshal(body, &installs); err != nil {
		return nil, err
	}

	var out []InstallationAuth
	for _, inst := range installs {
		treq, _ := http.NewRequestWithContext(ctx, http.MethodPost,
			fmt.Sprintf("%s/app/installations/%d/access_tokens", apiBase, inst.ID), bytes.NewReader(nil))
		treq.Header.Set("Accept", "application/vnd.github+json")
		treq.Header.Set("Authorization", "Bearer "+jwt)
		tres, err := client.Do(treq)
		if err != nil {
			return nil, err
		}
		tbody, _ := io.ReadAll(io.LimitReader(tres.Body, 1<<20))
		tres.Body.Close()
		if tres.StatusCode != http.StatusCreated {
			return nil, fmt.Errorf("installation token %d: HTTP %d: %.200s", inst.ID, tres.StatusCode, tbody)
		}
		var tok struct {
			Token string `json:"token"`
		}
		if err := json.Unmarshal(tbody, &tok); err != nil {
			return nil, err
		}
		out = append(out, InstallationAuth{InstallID: inst.ID, Org: inst.Account.Login, Token: tok.Token})
	}
	return out, nil
}
