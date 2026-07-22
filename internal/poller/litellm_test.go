package poller

import (
	"encoding/json"
	"testing"
	"time"
)

// Parsing must survive LiteLLM's shape variance: current field names,
// legacy field names, and unknown records (skipped, never fatal).
func TestLitellmRecordParsing(t *testing.T) {
	cases := []struct {
		raw       string
		wantDay   string
		wantSpend float64
		ok        bool
	}{
		{`{"group_by_day": "2026-07-21", "total_spend": 12.5, "breakdown": {"models": {}}}`, "2026-07-21", 12.5, true},
		{`{"date": "2026-07-20T00:00:00", "spend": "3.25"}`, "2026-07-20", 3.25, true},
		{`{"startTime": "2026-07-19T00:00:00Z", "total": 0}`, "2026-07-19", 0, true},
		{`{"unknown_shape": true}`, "", 0, false},
	}
	for _, c := range cases {
		var rec map[string]json.RawMessage
		if err := json.Unmarshal([]byte(c.raw), &rec); err != nil {
			t.Fatal(err)
		}
		day, okDay := litellmDate(rec)
		spend, okSpend := litellmSpend(rec)
		if (okDay && okSpend) != c.ok {
			t.Errorf("%s: parseability want %v", c.raw, c.ok)
			continue
		}
		if !c.ok {
			continue
		}
		if day.Format("2006-01-02") != c.wantDay {
			t.Errorf("%s: day %s want %s", c.raw, day.Format(time.DateOnly), c.wantDay)
		}
		if spend != c.wantSpend {
			t.Errorf("%s: spend %v want %v", c.raw, spend, c.wantSpend)
		}
	}
}
