// Package otlp parses OTLP/HTTP JSON metric exports and extracts the
// claude_code.* data points Scuttledeck rolls up. Unknown fields pass
// through unharmed (schema drift is logged by callers, never a crash), and
// nothing resembling content survives extraction — metadata only.
package otlp

import (
	"encoding/json"
	"strconv"
)

const (
	MetricTokenUsage = "claude_code.token.usage"
	MetricCostUsage  = "claude_code.cost.usage"

	AttrGithubRepo     = "github.repo"
	AttrGithubRunID    = "github.run_id"
	AttrGithubWorkflow = "github.workflow"
	AttrGithubPRNumber = "github.pr_number"
)

// FlexInt tolerates proto3-JSON int64 (string) and plain numbers.
type FlexInt struct {
	Value float64
	Set   bool
}

func (f *FlexInt) UnmarshalJSON(b []byte) error {
	if len(b) == 0 || string(b) == "null" {
		return nil
	}
	if b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return nil // tolerate, treat as unset
		}
		if n, err := strconv.ParseFloat(s, 64); err == nil {
			f.Value, f.Set = n, true
		}
		return nil
	}
	var n float64
	if err := json.Unmarshal(b, &n); err != nil {
		return nil
	}
	f.Value, f.Set = n, true
	return nil
}

type anyValue struct {
	StringValue *string  `json:"stringValue"`
	IntValue    *FlexInt `json:"intValue"`
	DoubleValue *float64 `json:"doubleValue"`
	BoolValue   *bool    `json:"boolValue"`
}

type keyValue struct {
	Key   string    `json:"key"`
	Value *anyValue `json:"value"`
}

type dataPoint struct {
	Attributes []keyValue `json:"attributes"`
	AsDouble   *float64   `json:"asDouble"`
	AsInt      *FlexInt   `json:"asInt"`
}

type sum struct {
	DataPoints             []dataPoint `json:"dataPoints"`
	AggregationTemporality int         `json:"aggregationTemporality"`
}

type gauge struct {
	DataPoints []dataPoint `json:"dataPoints"`
}

type metric struct {
	Name  string `json:"name"`
	Sum   *sum   `json:"sum"`
	Gauge *gauge `json:"gauge"`
}

type scopeMetrics struct {
	Metrics []metric `json:"metrics"`
}

type resource struct {
	Attributes []keyValue `json:"attributes"`
}

type resourceMetrics struct {
	Resource     *resource      `json:"resource"`
	ScopeMetrics []scopeMetrics `json:"scopeMetrics"`
}

// Request is the OTLP ExportMetricsServiceRequest (JSON encoding).
type Request struct {
	ResourceMetrics []resourceMetrics `json:"resourceMetrics"`
}

type Temporality string

const (
	Delta      Temporality = "delta"
	Cumulative Temporality = "cumulative"
)

type MetricPoint struct {
	SessionID   string      `json:"sessionId"`
	Metric      string      `json:"metric"`
	AttrType    string      `json:"attrType"`
	Model       string      `json:"model"`
	Value       float64     `json:"value"`
	Temporality Temporality `json:"temporality"`
}

type Batch struct {
	ResourceAttrs map[string]string `json:"resourceAttrs"`
	Points        []MetricPoint     `json:"points"`
}

func attrsToMap(kvs []keyValue) map[string]string {
	out := map[string]string{}
	for _, kv := range kvs {
		v := kv.Value
		if v == nil {
			continue
		}
		switch {
		case v.StringValue != nil:
			out[kv.Key] = *v.StringValue
		case v.IntValue != nil && v.IntValue.Set:
			out[kv.Key] = strconv.FormatFloat(v.IntValue.Value, 'f', -1, 64)
		case v.DoubleValue != nil:
			out[kv.Key] = strconv.FormatFloat(*v.DoubleValue, 'f', -1, 64)
		case v.BoolValue != nil:
			out[kv.Key] = strconv.FormatBool(*v.BoolValue)
		}
	}
	return out
}

func pointValue(dp dataPoint) (float64, bool) {
	if dp.AsDouble != nil {
		return *dp.AsDouble, true
	}
	if dp.AsInt != nil && dp.AsInt.Set {
		return dp.AsInt.Value, true
	}
	return 0, false
}

// Extract pulls every claude_code.* numeric data point carrying a session.id
// attribute, grouped by resource. Everything else is discarded.
func Extract(req *Request) []Batch {
	var batches []Batch
	for _, rm := range req.ResourceMetrics {
		var resourceAttrs map[string]string
		if rm.Resource != nil {
			resourceAttrs = attrsToMap(rm.Resource.Attributes)
		} else {
			resourceAttrs = map[string]string{}
		}

		var points []MetricPoint
		for _, sm := range rm.ScopeMetrics {
			for _, m := range sm.Metrics {
				if len(m.Name) < len("claude_code.") || m.Name[:len("claude_code.")] != "claude_code." {
					continue
				}
				var dps []dataPoint
				temporality := Cumulative
				if m.Sum != nil {
					dps = m.Sum.DataPoints
					// AGGREGATION_TEMPORALITY_DELTA = 1
					if m.Sum.AggregationTemporality == 1 {
						temporality = Delta
					}
				} else if m.Gauge != nil {
					dps = m.Gauge.DataPoints
				}
				for _, dp := range dps {
					attrs := attrsToMap(dp.Attributes)
					sessionID := attrs["session.id"]
					value, ok := pointValue(dp)
					if sessionID == "" || !ok {
						continue
					}
					points = append(points, MetricPoint{
						SessionID:   sessionID,
						Metric:      m.Name,
						AttrType:    attrs["type"],
						Model:       attrs["model"],
						Value:       value,
						Temporality: temporality,
					})
				}
			}
		}
		if len(points) > 0 {
			batches = append(batches, Batch{ResourceAttrs: resourceAttrs, Points: points})
		}
	}
	return batches
}

// GithubHints are the correlation hints scuttledeck/setup injects as
// resource attributes.
type GithubHints struct {
	RepoFullName string
	GhRunID      int64
	PRNumber     int
	Workflow     string
}

func ParseGithubHints(attrs map[string]string) GithubHints {
	var h GithubHints
	h.RepoFullName = attrs[AttrGithubRepo]
	if n, err := strconv.ParseInt(attrs[AttrGithubRunID], 10, 64); err == nil && n > 0 {
		h.GhRunID = n
	}
	if n, err := strconv.Atoi(attrs[AttrGithubPRNumber]); err == nil && n > 0 {
		h.PRNumber = n
	}
	h.Workflow = attrs[AttrGithubWorkflow]
	return h
}
