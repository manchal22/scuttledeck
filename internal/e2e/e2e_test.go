// End-to-end over the real stack: HTTP handlers → job queue → workers →
// Postgres. Requires DATABASE_URL (scripts/e2e.sh provides it); skipped
// otherwise. This is the P0 exit criterion: a webhook-ingested run ends up
// with its OTel-ingested agent session and true token cost attached.
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
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/scuttledeck/scuttledeck/internal/db"
	"github.com/scuttledeck/scuttledeck/internal/httpapi"
	"github.com/scuttledeck/scuttledeck/internal/queue"
)

const (
	webhookSecret = "test-webhook-secret"
	ingestToken   = "test-ingest-token"
	fixtureRunID  = int64(16123456789)
	fixtureSess   = "9f8e7d6c-5b4a-4321-9876-fedcba098765"
)

var (
	pool   *pgxpool.Pool
	server *httptest.Server
)

func TestMain(m *testing.M) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		fmt.Println("skipping e2e: DATABASE_URL not set (run scripts/e2e.sh)")
		os.Exit(0)
	}
	ctx := context.Background()

	var err error
	pool, err = db.Connect(ctx, url)
	must(err)
	for _, stmt := range []string{
		`drop schema if exists public cascade`,
		`drop schema if exists pgboss cascade`,
		`drop schema if exists drizzle cascade`,
		`create schema public`,
	} {
		_, err = pool.Exec(ctx, stmt)
		must(err)
	}
	must(db.Migrate(ctx, pool))
	_, err = pool.Exec(ctx, `
		insert into installation (org, github_install_id, ingest_token_hash)
		values ('acme-fixture', 61234567, $1)`, httpapi.Sha256Hex(ingestToken))
	must(err)

	workerCtx, cancel := context.WithCancel(ctx)
	worker := queue.NewWorker(pool, 200*time.Millisecond)
	queue.RegisterDefaultHandlers(worker, pool)
	worker.Start(workerCtx)

	server = httptest.NewServer((&httpapi.Server{Pool: pool, WebhookSecret: webhookSecret}).Handler())

	code := m.Run()
	server.Close()
	cancel()
	pool.Close()
	os.Exit(code)
}

func must(err error) {
	if err != nil {
		fmt.Println("e2e setup:", err)
		os.Exit(1)
	}
}

func sign(body []byte) string {
	mac := hmac.New(sha256.New, []byte(webhookSecret))
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

func loadFixture(t *testing.T, name string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

func postWebhook(t *testing.T, payload map[string]any, sigOverride, deliveryID string) *http.Response {
	t.Helper()
	body, _ := json.Marshal(payload)
	sig := sigOverride
	if sig == "" {
		sig = sign(body)
	}
	if deliveryID == "" {
		deliveryID = fmt.Sprintf("delivery-%d", time.Now().UnixNano())
	}
	req, _ := http.NewRequest(http.MethodPost, server.URL+"/webhooks/github", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-GitHub-Event", "workflow_run")
	req.Header.Set("X-GitHub-Delivery", deliveryID)
	req.Header.Set("X-Hub-Signature-256", sig)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func postOtlp(t *testing.T, payload map[string]any, token string) *http.Response {
	t.Helper()
	body, _ := json.Marshal(payload)
	req, _ := http.NewRequest(http.MethodPost, server.URL+"/v1/otlp/metrics", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

// makeWorkflowRunPayload clones the fixture for a fresh run id, timestamped near now.
func makeWorkflowRunPayload(t *testing.T, ghRunID int64, startedSecondsAgo int) map[string]any {
	doc := loadFixture(t, "workflow_run.completed.json")
	wr := doc["workflow_run"].(map[string]any)
	started := time.Now().Add(-time.Duration(startedSecondsAgo) * time.Second).UTC()
	wr["id"] = ghRunID
	wr["created_at"] = started.Format(time.RFC3339)
	wr["run_started_at"] = started.Format(time.RFC3339)
	wr["updated_at"] = time.Now().UTC().Format(time.RFC3339)
	return doc
}

// makeOtlpPayload clones the OTLP fixture for a session; ghRunID<0 strips the hint.
func makeOtlpPayload(t *testing.T, sessionID string, ghRunID int64) map[string]any {
	doc := loadFixture(t, "otlp-metrics.json")
	rm := doc["resourceMetrics"].([]any)[0].(map[string]any)
	resource := rm["resource"].(map[string]any)
	attrs := resource["attributes"].([]any)
	kept := make([]any, 0, len(attrs))
	for _, a := range attrs {
		kv := a.(map[string]any)
		if kv["key"] == "github.run_id" {
			if ghRunID < 0 {
				continue
			}
			kv["value"].(map[string]any)["stringValue"] = fmt.Sprint(ghRunID)
		}
		kept = append(kept, a)
	}
	resource["attributes"] = kept
	for _, smAny := range rm["scopeMetrics"].([]any) {
		for _, mAny := range smAny.(map[string]any)["metrics"].([]any) {
			m := mAny.(map[string]any)
			sum := m["sum"].(map[string]any)
			for _, dpAny := range sum["dataPoints"].([]any) {
				for _, aAny := range dpAny.(map[string]any)["attributes"].([]any) {
					kv := aAny.(map[string]any)
					if kv["key"] == "session.id" {
						kv["value"].(map[string]any)["stringValue"] = sessionID
					}
				}
			}
		}
	}
	return doc
}

func waitFor(t *testing.T, what string, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

type sessionRow struct {
	RunID        *int64
	Confidence   string
	Model        *string
	TokIn        int64
	TokOut       int64
	TokCacheRead int64
	TokCacheCr   int64
	CostUsd      *string
	RepoFullName *string
}

func findSession(t *testing.T, sessionID string) *sessionRow {
	t.Helper()
	var s sessionRow
	err := pool.QueryRow(context.Background(), `
		select run_id, confidence, model, tok_in, tok_out, tok_cache_read, tok_cache_create, cost_usd, repo_full_name
		from agent_session where session_id = $1`, sessionID).
		Scan(&s.RunID, &s.Confidence, &s.Model, &s.TokIn, &s.TokOut, &s.TokCacheRead, &s.TokCacheCr, &s.CostUsd, &s.RepoFullName)
	if err == pgx.ErrNoRows {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	return &s
}

func findRunID(t *testing.T, ghRunID int64) *int64 {
	t.Helper()
	var id int64
	err := pool.QueryRow(context.Background(), `select id from run where gh_run_id = $1`, ghRunID).Scan(&id)
	if err == pgx.ErrNoRows {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	return &id
}

func TestRejectsBadSignature(t *testing.T) {
	res := postWebhook(t, loadFixture(t, "workflow_run.completed.json"), "sha256="+hex.EncodeToString(make([]byte, 32)), "")
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", res.StatusCode)
	}
}

func TestRejectsUnknownToken(t *testing.T) {
	res := postOtlp(t, loadFixture(t, "otlp-metrics.json"), "wrong-token")
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", res.StatusCode)
	}
}

func TestWorkflowRunNormalized(t *testing.T) {
	res := postWebhook(t, loadFixture(t, "workflow_run.completed.json"), "", "")
	if res.StatusCode != http.StatusAccepted {
		t.Fatalf("want 202, got %d", res.StatusCode)
	}

	waitFor(t, "run row", func() bool { return findRunID(t, fixtureRunID) != nil })

	var (
		status, conclusion, trigger, actor, wfPath string
		prNumber, durationS                        int
	)
	err := pool.QueryRow(context.Background(), `
		select status, conclusion, trigger_event, actor, workflow_path, pr_number, duration_s
		from run where gh_run_id = $1`, fixtureRunID).
		Scan(&status, &conclusion, &trigger, &actor, &wfPath, &prNumber, &durationS)
	if err != nil {
		t.Fatal(err)
	}
	if status != "completed" || conclusion != "success" || trigger != "issue_comment" ||
		actor != "octocat-dev" || prNumber != 42 || durationS != 270 ||
		wfPath != ".github/workflows/claude-review.yml" {
		t.Errorf("normalization wrong: %s %s %s %s %s %d %d", status, conclusion, trigger, actor, wfPath, prNumber, durationS)
	}
}

func TestDuplicateDeliveryNotReprocessed(t *testing.T) {
	payload := loadFixture(t, "workflow_run.completed.json")
	first := postWebhook(t, payload, "", "dup-delivery-001")
	second := postWebhook(t, payload, "", "dup-delivery-001")
	if first.StatusCode != http.StatusAccepted || second.StatusCode != http.StatusAccepted {
		t.Fatalf("want 202/202, got %d/%d", first.StatusCode, second.StatusCode)
	}
	var out struct {
		Duplicate bool `json:"duplicate"`
	}
	_ = json.NewDecoder(second.Body).Decode(&out)
	if !out.Duplicate {
		t.Error("second delivery not flagged duplicate")
	}
	var n int
	_ = pool.QueryRow(context.Background(),
		`select count(*) from webhook_delivery where delivery_id = 'dup-delivery-001'`).Scan(&n)
	if n != 1 {
		t.Errorf("want 1 stored delivery, got %d", n)
	}
}

func TestOtelCostJoinsExact_P0Exit(t *testing.T) {
	res := postOtlp(t, loadFixture(t, "otlp-metrics.json"), ingestToken)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", res.StatusCode)
	}

	waitFor(t, "correlated session", func() bool {
		s := findSession(t, fixtureSess)
		return s != nil && s.RunID != nil
	})

	s := findSession(t, fixtureSess)
	runID := findRunID(t, fixtureRunID)
	if *s.RunID != *runID {
		t.Errorf("joined to wrong run: %d != %d", *s.RunID, *runID)
	}
	if s.Confidence != "exact" {
		t.Errorf("want exact, got %s", s.Confidence)
	}
	if s.Model == nil || *s.Model != "claude-sonnet-5" {
		t.Errorf("model wrong: %v", s.Model)
	}
	if s.TokIn != 45123 || s.TokOut != 8901 || s.TokCacheRead != 230450 || s.TokCacheCr != 12034 {
		t.Errorf("token totals wrong: %d %d %d %d", s.TokIn, s.TokOut, s.TokCacheRead, s.TokCacheCr)
	}
	if s.CostUsd == nil || *s.CostUsd != "1.234567" {
		t.Errorf("cost wrong: %v", s.CostUsd)
	}
	if s.RepoFullName == nil || *s.RepoFullName != "acme-fixture/api" {
		t.Errorf("repo wrong: %v", s.RepoFullName)
	}
}

func TestCumulativeRedeliveryNeverDoubleCounts(t *testing.T) {
	res := postOtlp(t, loadFixture(t, "otlp-metrics.json"), ingestToken)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", res.StatusCode)
	}
	time.Sleep(2 * time.Second) // let the worker process the duplicate
	s := findSession(t, fixtureSess)
	if s.TokIn != 45123 {
		t.Errorf("double-counted: tok_in = %d", s.TokIn)
	}
	if *s.CostUsd != "1.234567" {
		t.Errorf("double-counted: cost = %s", *s.CostUsd)
	}
}

func TestTelemetryBeforeWebhookIsClaimed(t *testing.T) {
	const ghRunID = int64(16999900001)
	const sessionID = "otel-first-session-0001"

	postOtlp(t, makeOtlpPayload(t, sessionID, ghRunID), ingestToken)
	waitFor(t, "pending session", func() bool { return findSession(t, sessionID) != nil })
	if s := findSession(t, sessionID); s.RunID != nil || s.Confidence != "unmatched" {
		t.Fatalf("session should be unmatched before webhook: %+v", s)
	}

	postWebhook(t, makeWorkflowRunPayload(t, ghRunID, 120), "", "")
	waitFor(t, "run-side claim", func() bool {
		s := findSession(t, sessionID)
		return s != nil && s.RunID != nil
	})
	s := findSession(t, sessionID)
	if s.Confidence != "exact" {
		t.Errorf("want exact, got %s", s.Confidence)
	}
	if runID := findRunID(t, ghRunID); *s.RunID != *runID {
		t.Errorf("claimed wrong run")
	}
}

func TestHeuristicFallbackWithoutRunIDAttr(t *testing.T) {
	const ghRunID = int64(16999900002)
	const sessionID = "hintless-session-0001"

	postWebhook(t, makeWorkflowRunPayload(t, ghRunID, 60), "", "")
	waitFor(t, "heuristic-target run", func() bool { return findRunID(t, ghRunID) != nil })

	postOtlp(t, makeOtlpPayload(t, sessionID, -1), ingestToken)
	waitFor(t, "heuristic correlation", func() bool {
		s := findSession(t, sessionID)
		return s != nil && s.RunID != nil
	})
	if s := findSession(t, sessionID); s.Confidence != "heuristic" {
		t.Errorf("want heuristic, got %s", s.Confidence)
	}
}

func TestStandardOtlpPathAndLogsDropped(t *testing.T) {
	req, _ := http.NewRequest(http.MethodPost, server.URL+"/v1/metrics",
		bytes.NewReader([]byte(`{"resourceMetrics":[]}`)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+ingestToken)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusOK {
		t.Errorf("alias path: want 200, got %d", res.StatusCode)
	}

	logs, _ := http.NewRequest(http.MethodPost, server.URL+"/v1/logs",
		bytes.NewReader([]byte(`{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"body":{"stringValue":"secret prompt"}}]}]}]}`)))
	logs.Header.Set("Content-Type", "application/json")
	logsRes, err := http.DefaultClient.Do(logs)
	if err != nil {
		t.Fatal(err)
	}
	if logsRes.StatusCode != http.StatusOK {
		t.Errorf("logs drop: want 200, got %d", logsRes.StatusCode)
	}
	var n int
	_ = pool.QueryRow(context.Background(),
		`select count(*) from webhook_delivery where payload::text like '%secret prompt%'`).Scan(&n)
	if n != 0 {
		t.Error("log body was persisted — security invariant violated")
	}
}
