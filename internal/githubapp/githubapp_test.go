package githubapp

import (
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
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func testPEM(t *testing.T) (string, *rsa.PrivateKey) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	block := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	return string(block), key
}

func TestJWT(t *testing.T) {
	pemStr, key := testPEM(t)
	app := &App{AppID: 12345, PEM: pemStr}
	jwt, err := app.JWT()
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(jwt, ".")
	if len(parts) != 3 {
		t.Fatalf("want 3 JWT parts, got %d", len(parts))
	}
	payload, _ := base64.RawURLEncoding.DecodeString(parts[1])
	var claims struct {
		Iss int64 `json:"iss"`
		Iat int64 `json:"iat"`
		Exp int64 `json:"exp"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		t.Fatal(err)
	}
	if claims.Iss != 12345 || claims.Exp <= claims.Iat {
		t.Errorf("claims wrong: %+v", claims)
	}
	// signature must verify against the public key
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	sig, _ := base64.RawURLEncoding.DecodeString(parts[2])
	if err := rsa.VerifyPKCS1v15(&key.PublicKey, crypto.SHA256, digest[:], sig); err != nil {
		t.Errorf("signature does not verify: %v", err)
	}
}

func TestBuildManifest(t *testing.T) {
	m := BuildManifest("https://scuttledeck.example.com", "acme")
	perms := m["default_permissions"].(map[string]string)
	for _, k := range []string{"actions", "contents", "pull_requests", "metadata"} {
		if perms[k] != "read" {
			t.Errorf("permission %s must be read, got %q", k, perms[k])
		}
	}
	hook := m["hook_attributes"].(map[string]any)
	if hook["url"] != "https://scuttledeck.example.com/webhooks/github" {
		t.Errorf("hook url wrong: %v", hook["url"])
	}
	if m["public"] != false {
		t.Error("app must be private")
	}
	long := BuildManifest("https://x", "an-organization-with-a-very-long-name-indeed")
	if len(long["name"].(string)) > 34 {
		t.Errorf("name exceeds GitHub's 34-char limit: %q", long["name"])
	}
}

func TestExchangeCode(t *testing.T) {
	pemStr, _ := testPEM(t)
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/app-manifests/one-time-code/conversions" || r.Method != http.MethodPost {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusCreated)
		fmt.Fprintf(w, `{"id": 777, "slug": "scuttledeck-acme", "pem": %q,
			"webhook_secret": "whsec", "html_url": "https://github.com/apps/scuttledeck-acme",
			"owner": {"login": "acme"}}`, pemStr)
	}))
	defer mock.Close()

	app, err := ExchangeCode(context.Background(), mock.URL, "one-time-code")
	if err != nil {
		t.Fatal(err)
	}
	if app.AppID != 777 || app.Owner != "acme" || app.WebhookSecret != "whsec" {
		t.Errorf("converted app wrong: %+v", app)
	}
	if _, err := app.JWT(); err != nil {
		t.Errorf("converted PEM does not mint JWTs: %v", err)
	}
}

func TestInstallationTokens(t *testing.T) {
	pemStr, _ := testPEM(t)
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "Bearer ey") && !strings.Contains(auth, ".") {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch {
		case r.URL.Path == "/app/installations":
			fmt.Fprint(w, `[{"id": 42, "account": {"login": "acme"}}]`)
		case r.URL.Path == "/app/installations/42/access_tokens" && r.Method == http.MethodPost:
			w.WriteHeader(http.StatusCreated)
			fmt.Fprint(w, `{"token": "ghs_installation_token"}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer mock.Close()

	app := &App{AppID: 777, PEM: pemStr}
	auths, err := app.InstallationTokens(context.Background(), mock.URL)
	if err != nil {
		t.Fatal(err)
	}
	if len(auths) != 1 || auths[0].Org != "acme" || auths[0].Token != "ghs_installation_token" {
		t.Errorf("auths wrong: %+v", auths)
	}
}
