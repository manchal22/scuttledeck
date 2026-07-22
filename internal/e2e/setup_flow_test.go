package e2e

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"testing"
	"time"

	"github.com/scuttledeck/scuttledeck/internal/httpapi"
)

// The setup flow end-to-end against a mock GitHub: the page is gated by the
// ingest token, the callback only accepts states this instance minted, the
// conversion stores credentials, and app-signed webhooks then verify.
func TestGithubAppSetupFlow(t *testing.T) {
	mockGithub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/app-manifests/live-code/conversions" && r.Method == http.MethodPost {
			w.WriteHeader(http.StatusCreated)
			fmt.Fprint(w, `{"id": 9001, "slug": "scuttledeck-acme-fixture",
				"pem": "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\nKUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQJAIJLixBy2qpFoS4DSmoEm\no3qGy0t6z09AIJtH+5OeRV1be+N4cDYJKffGzDa88vQENZiRm0GRq6a+HPGQMd2k\nTQIhAKMSvzIBnni7ot/OSie2TmJLY4SwTQAevXysE2RbFDYdAiEBCUEaRQnMnbp7\n9mxDXDf6AU0cN/RPBjb9qSHDcWZHGzUCIG2Es59z8ugGrDY+pxLQnwfotadxd+Uy\nv/Ow5T0q5gIJAiEAyS4RaI9YG8EWx/2w0T67ZUVAw8eOMB6BIUg0Xcu+3okCIBOs\n/5OiPgoTdSy7bcF9IGpSE8ZgGKzgYQVZeN97YE00\n-----END RSA PRIVATE KEY-----",
				"webhook_secret": "app-webhook-secret-xyz",
				"html_url": "https://github.com/apps/scuttledeck-acme-fixture",
				"owner": {"login": "acme-fixture"}}`)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer mockGithub.Close()

	appServer := httptest.NewServer((&httpapi.Server{
		Pool:             pool,
		WebhookSecret:    webhookSecret,
		GithubAPIBaseURL: mockGithub.URL,
	}).Handler())
	defer appServer.Close()

	// page requires the ingest token
	res, _ := http.Get(appServer.URL + "/setup/github")
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("setup page without token: want 401, got %d", res.StatusCode)
	}
	res, _ = http.Get(appServer.URL + "/setup/github?token=" + ingestToken)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("setup page: want 200, got %d", res.StatusCode)
	}
	buf := make([]byte, 64<<10)
	n, _ := res.Body.Read(buf)
	page := string(buf[:n])
	m := regexp.MustCompile(`state=([0-9a-f]{32})`).FindStringSubmatch(page)
	if m == nil {
		t.Fatal("no state in setup page")
	}
	state := m[1]

	// callback rejects a state this instance never minted
	res, _ = http.Get(appServer.URL + "/setup/github/callback?code=live-code&state=" + "0000000000000000000000000000dead")
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("forged state: want 403, got %d", res.StatusCode)
	}

	// valid state converts and stores the app
	res, _ = http.Get(appServer.URL + "/setup/github/callback?code=live-code&state=" + state)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("callback: want 200, got %d", res.StatusCode)
	}
	var appID int64
	if err := pool.QueryRow(context.Background(),
		`select app_id from github_app order by id desc limit 1`).Scan(&appID); err != nil || appID != 9001 {
		t.Fatalf("app not stored: id=%d err=%v", appID, err)
	}

	// state is single-use
	res, _ = http.Get(appServer.URL + "/setup/github/callback?code=live-code&state=" + state)
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("state reuse: want 403, got %d", res.StatusCode)
	}

	// a webhook signed with the app's secret now verifies
	payload := map[string]any{"action": "created"}
	res2 := postEventSigned(t, appServer.URL, "installation", payload, "app-webhook-secret-xyz")
	if res2.StatusCode != http.StatusAccepted {
		t.Fatalf("app-signed webhook: want 202, got %d", res2.StatusCode)
	}
}

func postEventSigned(t *testing.T, serverURL, event string, payload map[string]any, secret string) *http.Response {
	t.Helper()
	body, _ := json.Marshal(payload)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	req, _ := http.NewRequest(http.MethodPost, serverURL+"/webhooks/github", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-GitHub-Event", event)
	req.Header.Set("X-GitHub-Delivery", "app-evt-"+time.Now().Format("150405.000000"))
	req.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}
