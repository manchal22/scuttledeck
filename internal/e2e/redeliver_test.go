package e2e

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/scuttledeck/scuttledeck/internal/poller"
)

// The sweeper must redeliver exactly the failed deliveries we never
// received: not succeeded ones, not ones already in webhook_delivery, and
// not stale ones outside the lookback.
func TestRedeliverySweep(t *testing.T) {
	ctx := context.Background()

	// A delivery that DID reach us despite GitHub logging a failure (timeout
	// after processing): must not be redelivered.
	if _, err := pool.Exec(ctx, `
		insert into webhook_delivery (delivery_id, event, payload)
		values ('guid-already-received', 'workflow_run', '{}')
		on conflict do nothing`); err != nil {
		t.Fatal(err)
	}

	now := time.Now().UTC().Format(time.RFC3339)
	stale := time.Now().Add(-72 * time.Hour).UTC().Format(time.RFC3339)
	var redelivered atomic.Int64
	var redeliveredID atomic.Int64

	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/orgs/acme-fixture/hooks" && r.Method == http.MethodGet:
			fmt.Fprint(w, `[{"id": 900, "config": {"url": "http://scuttledeck.internal/webhooks/github"}},
			                {"id": 901, "config": {"url": "https://other-tool.example/hook"}}]`)
		case r.URL.Path == "/orgs/acme-fixture/hooks/900/deliveries":
			fmt.Fprintf(w, `[
			  {"id": 1, "guid": "guid-lost", "delivered_at": %q, "status_code": 502, "event": "workflow_run"},
			  {"id": 2, "guid": "guid-ok", "delivered_at": %q, "status_code": 200, "event": "workflow_run"},
			  {"id": 3, "guid": "guid-already-received", "delivered_at": %q, "status_code": 502, "event": "workflow_run"},
			  {"id": 4, "guid": "guid-too-old", "delivered_at": %q, "status_code": 502, "event": "workflow_run"},
			  {"id": 5, "guid": "guid-recovered", "delivered_at": %q, "status_code": 502, "event": "push", "redelivery": false},
			  {"id": 6, "guid": "guid-recovered", "delivered_at": %q, "status_code": 202, "event": "push", "redelivery": true}
			]`, now, now, now, stale, now, now)
		case r.Method == http.MethodPost && r.URL.Path == "/orgs/acme-fixture/hooks/900/deliveries/1/attempts":
			redelivered.Add(1)
			redeliveredID.Store(1)
			w.WriteHeader(http.StatusAccepted)
		case r.Method == http.MethodPost:
			redelivered.Add(100) // any other redelivery is a bug
			w.WriteHeader(http.StatusAccepted)
		default:
			// repo-level hook listings and unknown scopes: none
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer mock.Close()

	if err := poller.RunRedelivery(ctx, pool, mock.URL, "test-token"); err != nil {
		t.Fatal(err)
	}
	if got := redelivered.Load(); got != 1 {
		t.Fatalf("want exactly 1 redelivery (guid-lost), got %d", got)
	}
}
