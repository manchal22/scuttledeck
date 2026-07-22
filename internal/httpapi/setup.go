package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html"
	"log"
	"net/http"
	"strings"

	"github.com/scuttledeck/scuttledeck/internal/githubapp"
)

// The GitHub App setup flow. GET /setup/github (gated by the ingest token)
// serves a page whose single button posts a pre-filled app manifest to
// GitHub; GitHub redirects back to /setup/github/callback with a one-time
// code that converts into the app's credentials. A random state value,
// stored single-use, ties the callback to a page this instance served.

func (s *Server) externalURL(r *http.Request) string {
	if s.ExternalURL != "" {
		return strings.TrimSuffix(s.ExternalURL, "/")
	}
	scheme := "http"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	host := r.Header.Get("X-Forwarded-Host")
	if host == "" {
		host = r.Host
	}
	return scheme + "://" + host
}

func (s *Server) handleSetupPage(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if token == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "append ?token=<ingest token>"})
		return
	}
	if _, err := s.installationForToken(r.Context(), token); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unknown ingest token"})
		return
	}

	org := r.URL.Query().Get("org")
	if org == "" {
		_ = s.Pool.QueryRow(r.Context(), `select org from installation order by id limit 1`).Scan(&org)
	}

	stateBytes := make([]byte, 16)
	_, _ = rand.Read(stateBytes)
	state := hex.EncodeToString(stateBytes)
	if _, err := s.Pool.Exec(r.Context(),
		`insert into setup_state (state) values ($1)`, state); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "state persistence failed"})
		return
	}

	manifest, _ := json.Marshal(githubapp.BuildManifest(s.externalURL(r), org))
	orgAction := fmt.Sprintf("https://github.com/organizations/%s/settings/apps/new?state=%s", html.EscapeString(org), state)
	userAction := fmt.Sprintf("https://github.com/settings/apps/new?state=%s", state)

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<!doctype html><html><head><meta charset="utf-8"><title>Scuttledeck — GitHub App setup</title>
<style>body{font-family:ui-monospace,monospace;background:#0e1c17;color:#dfe9e2;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{max-width:34rem;padding:2rem}h1{font-size:1.2rem;color:#2fd4a4}p{line-height:1.6;font-size:.85rem;color:#9db3a8}
button{background:#27a37f;color:#fff;border:0;border-radius:8px;padding:.7rem 1.6rem;font-size:1rem;font-weight:600;cursor:pointer;font-family:inherit}
button:hover{background:#2fd4a4}a{color:#2fd4a4}code{color:#dfe9e2}</style></head><body><main>
<h1>Create the Scuttledeck GitHub App</h1>
<p>One click creates a <strong>read-only</strong> GitHub App under <code>%s</code> — permissions
(actions, contents, pull requests, metadata: all read), events, and this instance's webhook URL
are pre-filled. GitHub will show the details before anything is created.</p>
<form action="%s" method="post">
<input type="hidden" name="manifest" value='%s'>
<button type="submit">Create app for %s →</button>
</form>
<p style="margin-top:1.2rem">Personal account instead of an org? <a href="#" onclick="document.forms[0].action='%s';document.forms[0].submit();return false;">create it under your user account</a>.</p>
</main></body></html>`,
		html.EscapeString(org), orgAction, html.EscapeString(string(manifest)), html.EscapeString(org), userAction)
}

func (s *Server) handleSetupCallback(w http.ResponseWriter, r *http.Request) {
	code := r.URL.Query().Get("code")
	state := r.URL.Query().Get("state")
	if code == "" || state == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing code or state"})
		return
	}
	// single-use state minted by this instance within the last hour
	tag, err := s.Pool.Exec(r.Context(),
		`delete from setup_state where state = $1 and created_at > now() - interval '1 hour'`, state)
	if err != nil || tag.RowsAffected() == 0 {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "unknown or expired setup state"})
		return
	}

	apiBase := s.GithubAPIBaseURL
	if apiBase == "" {
		apiBase = "https://api.github.com"
	}
	app, err := githubapp.ExchangeCode(r.Context(), apiBase, code)
	if err != nil {
		log.Printf("[setup] manifest conversion failed: %v", err)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "manifest conversion failed; retry the setup page"})
		return
	}
	if err := githubapp.Save(r.Context(), s.Pool, app); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "storing app credentials failed"})
		return
	}
	log.Printf("[setup] GitHub App %q (id %d, owner %s) registered", app.Slug, app.AppID, app.Owner)

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<!doctype html><html><head><meta charset="utf-8"><title>Scuttledeck — app created</title>
<style>body{font-family:ui-monospace,monospace;background:#0e1c17;color:#dfe9e2;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{max-width:34rem;padding:2rem}h1{font-size:1.2rem;color:#2fd4a4}p{line-height:1.6;font-size:.85rem;color:#9db3a8}
a.btn{display:inline-block;background:#27a37f;color:#fff;border-radius:8px;padding:.7rem 1.6rem;font-weight:600;text-decoration:none}a.btn:hover{background:#2fd4a4}</style>
</head><body><main>
<h1>✓ App created: %s</h1>
<p>Credentials are registered with this Scuttledeck instance — webhooks from the app
verify automatically, and discovery/redelivery now use short-lived installation tokens
(no PAT needed). One step left:</p>
<a class="btn" href="%s/installations/new">Install it on your repos →</a>
<p style="margin-top:1rem">Select all repos or just the ones running the Claude Code action.
New repos added later are picked up automatically.</p>
</main></body></html>`, html.EscapeString(app.Slug), html.EscapeString(app.HTMLURL))
}
