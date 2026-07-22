// Package httpapi is the ingest surface: HMAC-verified GitHub webhooks and
// token-authenticated OTLP metrics. Fast 2xx always — normalization happens
// in queue workers.
package httpapi

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/scuttledeck/scuttledeck/internal/githubapp"
	"github.com/scuttledeck/scuttledeck/internal/otlp"
	"github.com/scuttledeck/scuttledeck/internal/queue"
)

// Sha256Hex derives the stored lookup key for ingest tokens — the raw token
// never touches the database.
func Sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// VerifyGithubSignature checks X-Hub-Signature-256 over the raw body.
func VerifyGithubSignature(secret string, body []byte, header string) bool {
	const prefix = "sha256="
	if !strings.HasPrefix(header, prefix) {
		return false
	}
	provided, err := hex.DecodeString(header[len(prefix):])
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hmac.Equal(mac.Sum(nil), provided)
}

type Server struct {
	Pool          *pgxpool.Pool
	WebhookSecret string
	// ExternalURL overrides Host-header derivation for the setup flow.
	ExternalURL string
	// GithubAPIBaseURL overrides api.github.com (tests use a local server).
	GithubAPIBaseURL string
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func randomID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})

	mux.HandleFunc("POST /webhooks/github", s.handleGithubWebhook)

	mux.HandleFunc("GET /setup/github", s.handleSetupPage)
	mux.HandleFunc("GET /setup/github/callback", s.handleSetupCallback)

	mux.HandleFunc("POST /v1/otlp/metrics", s.handleOtlpMetrics)
	mux.HandleFunc("POST /v1/metrics", s.handleOtlpMetrics) // standard OTLP path

	// Logs and traces are acknowledged and dropped, never stored.
	drop := func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"partialSuccess": map[string]any{}})
	}
	mux.HandleFunc("POST /v1/logs", drop)
	mux.HandleFunc("POST /v1/traces", drop)

	return mux
}

func (s *Server) handleGithubWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unreadable body"})
		return
	}
	if !s.signatureValid(r.Context(), body, r.Header.Get("X-Hub-Signature-256")) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid signature"})
		return
	}

	event := r.Header.Get("X-GitHub-Event")
	if event == "" {
		event = "unknown"
	}
	deliveryID := r.Header.Get("X-GitHub-Delivery")
	if deliveryID == "" {
		deliveryID = randomID()
	}

	if !json.Valid(body) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	if event == "ping" {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true, "pong": true})
		return
	}

	var envelope struct {
		Action *string `json:"action"`
	}
	_ = json.Unmarshal(body, &envelope)

	tag, err := s.Pool.Exec(r.Context(), `
		insert into webhook_delivery (delivery_id, event, action, payload)
		values ($1, $2, $3, $4)
		on conflict (delivery_id) do nothing`,
		deliveryID, event, envelope.Action, body)
	if err != nil {
		log.Printf("[webhook] persist failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "storage failure"})
		return
	}
	if tag.RowsAffected() == 0 {
		// Redelivery of a seen delivery id — acknowledge, don't reprocess.
		writeJSON(w, http.StatusAccepted, map[string]bool{"ok": true, "duplicate": true})
		return
	}

	job := queue.GithubEventJob{DeliveryID: deliveryID, Event: event, Payload: body}
	if err := queue.Enqueue(r.Context(), s.Pool, queue.QueueGithubEvent, job); err != nil {
		log.Printf("[webhook] enqueue failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "queue failure"})
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]bool{"ok": true})
}

func (s *Server) handleOtlpMetrics(w http.ResponseWriter, r *http.Request) {
	auth := r.Header.Get("Authorization")
	token, ok := strings.CutPrefix(auth, "Bearer ")
	token = strings.TrimSpace(token)
	if !ok || token == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "missing bearer token"})
		return
	}
	installationID, err := s.installationForToken(r.Context(), token)
	if err == pgx.ErrNoRows {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unknown ingest token"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "lookup failure"})
		return
	}

	if ct := r.Header.Get("Content-Type"); !strings.Contains(ct, "application/json") {
		// scuttledeck/setup pins OTEL_EXPORTER_OTLP_PROTOCOL=http/json.
		writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{
			"error": "only application/json OTLP is supported; set OTEL_EXPORTER_OTLP_PROTOCOL=http/json",
		})
		return
	}

	body, err := readBody(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unreadable body"})
		return
	}
	var req otlp.Request
	if err := json.Unmarshal(body, &req); err != nil {
		log.Printf("[otlp] payload failed to parse (schema drift?): %v", err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unrecognized OTLP payload"})
		return
	}

	// Extraction keeps claude_code.* numeric points only — nothing resembling
	// content reaches the queue or the database.
	batches := otlp.Extract(&req)
	if len(batches) > 0 {
		job := queue.OtlpMetricsJob{InstallationID: installationID, Batches: batches}
		if err := queue.Enqueue(r.Context(), s.Pool, queue.QueueOtlpMetrics, job); err != nil {
			log.Printf("[otlp] enqueue failed: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "queue failure"})
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"partialSuccess": map[string]any{}})
}

// signatureValid accepts the env-configured webhook secret or any GitHub
// App secret registered via the setup flow.
func (s *Server) signatureValid(ctx context.Context, body []byte, header string) bool {
	if VerifyGithubSignature(s.WebhookSecret, body, header) {
		return true
	}
	secrets, err := githubapp.WebhookSecrets(ctx, s.Pool)
	if err != nil {
		log.Printf("[webhook] app secret lookup failed: %v", err)
		return false
	}
	for _, secret := range secrets {
		if VerifyGithubSignature(secret, body, header) {
			return true
		}
	}
	return false
}

func (s *Server) installationForToken(ctx context.Context, token string) (int64, error) {
	var id int64
	err := s.Pool.QueryRow(ctx,
		`select id from installation where ingest_token_hash = $1`, Sha256Hex(token)).Scan(&id)
	return id, err
}

func readBody(r *http.Request) ([]byte, error) {
	defer r.Body.Close()
	// 20 MiB cap — OTLP exports and webhook payloads are far smaller.
	return io.ReadAll(io.LimitReader(r.Body, 20<<20))
}
