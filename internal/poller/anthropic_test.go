package poller

import (
	"encoding/json"
	"testing"
)

// Fixture matching the documented Analytics report shape; parsing must
// tolerate extra fields and string-encoded numbers.
const analyticsFixture = `{
  "data": [
    {
      "date": "2026-07-20",
      "api_actor": "ci-key-payments",
      "customer_type": "api",
      "core_metrics": {"num_sessions": 14, "commits_by_claude_code": 3, "pull_requests_by_claude_code": 2},
      "model_breakdown": [
        {
          "model": "claude-sonnet-5",
          "tokens": {"input": "451230", "output": 89010, "cache_read": "2304500", "cache_creation": 120340},
          "estimated_cost": {"amount": 1234, "currency": "USD"}
        }
      ],
      "unknown_future_field": {"x": 1}
    },
    {
      "date": "not-a-date",
      "api_actor": "broken-record"
    }
  ],
  "has_more": false
}`

func TestAnalyticsPageParsing(t *testing.T) {
	var page analyticsPage
	if err := json.Unmarshal([]byte(analyticsFixture), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Data) != 2 || page.HasMore {
		t.Fatalf("page shape wrong: %d records, has_more=%v", len(page.Data), page.HasMore)
	}
	var rec analyticsRecord
	if err := json.Unmarshal(page.Data[0], &rec); err != nil {
		t.Fatal(err)
	}
	if rec.APIActor != "ci-key-payments" || rec.CoreMetrics.NumSessions != 14 {
		t.Errorf("record wrong: %+v", rec)
	}
	mb := rec.ModelBreakdown[0]
	if float64(mb.Tokens.Input) != 451230 || float64(mb.Tokens.Output) != 89010 {
		t.Errorf("tokens wrong (string/number mix): %+v", mb.Tokens)
	}
	if float64(mb.EstimatedCost.Amount) != 1234 {
		t.Errorf("cost wrong: %v", mb.EstimatedCost.Amount)
	}
}

const costReportFixture = `{
  "data": [
    {
      "starting_at": "2026-07-20T00:00:00Z",
      "results": [
        {"amount": "12.345678", "currency": "USD", "description": "Claude Sonnet 5 usage"},
        {"amount": "3.10", "currency": "USD"}
      ]
    }
  ],
  "has_more": false
}`

func TestCostReportParsing(t *testing.T) {
	var page costReportPage
	if err := json.Unmarshal([]byte(costReportFixture), &page); err != nil {
		t.Fatal(err)
	}
	total := 0.0
	for _, r := range page.Data[0].Results {
		total += float64(r.Amount)
	}
	if total < 15.44 || total > 15.45 {
		t.Errorf("summed amount wrong: %f", total)
	}
}
