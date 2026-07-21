package otlp

import (
	"encoding/json"
	"testing"
)

func parse(t *testing.T, raw string) *Request {
	t.Helper()
	var req Request
	if err := json.Unmarshal([]byte(raw), &req); err != nil {
		t.Fatalf("parse: %v", err)
	}
	return &req
}

const samplePayload = `{
  "resourceMetrics": [{
    "resource": {"attributes": [
      {"key": "service.name", "value": {"stringValue": "claude-code"}},
      {"key": "github.repo", "value": {"stringValue": "acme/api"}},
      {"key": "github.run_id", "value": {"stringValue": "16123456789"}},
      {"key": "github.pr_number", "value": {"stringValue": "42"}}
    ]},
    "scopeMetrics": [{
      "metrics": [
        {"name": "claude_code.token.usage", "sum": {
          "aggregationTemporality": 2, "isMonotonic": true,
          "dataPoints": [
            {"asDouble": 1200, "attributes": [{"key":"session.id","value":{"stringValue":"sess-1"}},{"key":"type","value":{"stringValue":"input"}},{"key":"model","value":{"stringValue":"claude-sonnet-5"}}]},
            {"asDouble": 340, "attributes": [{"key":"session.id","value":{"stringValue":"sess-1"}},{"key":"type","value":{"stringValue":"output"}},{"key":"model","value":{"stringValue":"claude-sonnet-5"}}]},
            {"asDouble": 9000, "attributes": [{"key":"session.id","value":{"stringValue":"sess-1"}},{"key":"type","value":{"stringValue":"cacheRead"}},{"key":"model","value":{"stringValue":"claude-sonnet-5"}}]}
          ]}},
        {"name": "claude_code.cost.usage", "sum": {
          "aggregationTemporality": 2,
          "dataPoints": [{"asDouble": 0.42, "attributes": [{"key":"session.id","value":{"stringValue":"sess-1"}},{"key":"model","value":{"stringValue":"claude-sonnet-5"}}]}]}},
        {"name": "some_other.metric", "sum": {"dataPoints": [{"asDouble": 1}]}}
      ]
    }]
  }]
}`

func TestExtract(t *testing.T) {
	batches := Extract(parse(t, samplePayload))
	if len(batches) != 1 {
		t.Fatalf("want 1 batch, got %d", len(batches))
	}
	b := batches[0]
	if b.ResourceAttrs["github.repo"] != "acme/api" {
		t.Errorf("resource attr lost: %v", b.ResourceAttrs)
	}
	if len(b.Points) != 4 {
		t.Fatalf("want 4 points, got %d", len(b.Points))
	}
	var input *MetricPoint
	for i := range b.Points {
		if b.Points[i].AttrType == "input" {
			input = &b.Points[i]
		}
	}
	if input == nil || input.Value != 1200 || input.Temporality != Cumulative || input.SessionID != "sess-1" {
		t.Errorf("input point wrong: %+v", input)
	}
}

func TestExtractStringAsInt(t *testing.T) {
	raw := `{"resourceMetrics":[{"scopeMetrics":[{"metrics":[
		{"name":"claude_code.token.usage","sum":{"aggregationTemporality":1,
		"dataPoints":[{"asInt":"5000","attributes":[{"key":"session.id","value":{"stringValue":"s"}},{"key":"type","value":{"stringValue":"input"}}]}]}}]}]}]}`
	batches := Extract(parse(t, raw))
	if len(batches) != 1 || len(batches[0].Points) != 1 {
		t.Fatal("expected one point")
	}
	p := batches[0].Points[0]
	if p.Value != 5000 || p.Temporality != Delta {
		t.Errorf("got %+v", p)
	}
}

func TestExtractDropsSessionlessPoints(t *testing.T) {
	raw := `{"resourceMetrics":[{"scopeMetrics":[{"metrics":[
		{"name":"claude_code.token.usage","sum":{"dataPoints":[{"asDouble":10,"attributes":[{"key":"type","value":{"stringValue":"input"}}]}]}}]}]}]}`
	if got := Extract(parse(t, raw)); len(got) != 0 {
		t.Errorf("sessionless point survived: %+v", got)
	}
}

func TestParseGithubHints(t *testing.T) {
	h := ParseGithubHints(map[string]string{
		"github.repo":      "acme/api",
		"github.run_id":    "16123456789",
		"github.pr_number": "42",
	})
	if h.RepoFullName != "acme/api" || h.GhRunID != 16123456789 || h.PRNumber != 42 {
		t.Errorf("got %+v", h)
	}
	if bad := ParseGithubHints(map[string]string{"github.run_id": "not-a-number"}); bad.GhRunID != 0 {
		t.Errorf("malformed run id accepted: %+v", bad)
	}
}
