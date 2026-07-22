// Package queue is a minimal Postgres-backed job queue: FOR UPDATE SKIP
// LOCKED polling, bounded retries with backoff. No external broker or Redis
// is required; Postgres is the only dependency.
package queue

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/scuttledeck/scuttledeck/internal/correlate"
	"github.com/scuttledeck/scuttledeck/internal/ghevents"
	"github.com/scuttledeck/scuttledeck/internal/otlp"
)

const (
	QueueGithubEvent = "github-event"
	QueueOtlpMetrics = "otlp-metrics"
)

type GithubEventJob struct {
	DeliveryID string          `json:"deliveryId"`
	Event      string          `json:"event"`
	Payload    json.RawMessage `json:"payload"`
}

type OtlpMetricsJob struct {
	InstallationID int64        `json:"installationId"`
	Batches        []otlp.Batch `json:"batches"`
}

// Enqueue inserts a job; workers pick it up within one poll interval.
func Enqueue(ctx context.Context, pool *pgxpool.Pool, queueName string, payload any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = pool.Exec(ctx,
		`insert into job_queue (queue, payload) values ($1, $2)`, queueName, body)
	return err
}

// Handler processes one job payload.
type Handler func(ctx context.Context, payload json.RawMessage) error

// Worker polls queues and dispatches to handlers until ctx is cancelled.
type Worker struct {
	pool     *pgxpool.Pool
	handlers map[string]Handler
	interval time.Duration
}

func NewWorker(pool *pgxpool.Pool, interval time.Duration) *Worker {
	return &Worker{pool: pool, handlers: map[string]Handler{}, interval: interval}
}

func (w *Worker) Handle(queueName string, h Handler) { w.handlers[queueName] = h }

// Start launches one polling goroutine per registered queue.
func (w *Worker) Start(ctx context.Context) {
	for queueName := range w.handlers {
		go w.loop(ctx, queueName)
	}
}

func (w *Worker) loop(ctx context.Context, queueName string) {
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()
	for {
		// Drain everything ready, then sleep one interval.
		for {
			ok, err := w.runOne(ctx, queueName)
			if err != nil {
				log.Printf("[queue] %s: %v", queueName, err)
				break
			}
			if !ok {
				break
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// runOne claims and processes a single job. Returns false when the queue is
// empty. Failures record the error and reschedule with linear backoff until
// max_attempts, then the job stays failed (done_at null, attempts maxed) for
// inspection.
func (w *Worker) runOne(ctx context.Context, queueName string) (bool, error) {
	tx, err := w.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)

	var (
		id       int64
		payload  json.RawMessage
		attempts int
	)
	err = tx.QueryRow(ctx, `
		select id, payload, attempts from job_queue
		where queue = $1 and done_at is null and run_after <= now() and attempts < max_attempts
		order by id
		for update skip locked
		limit 1`, queueName).Scan(&id, &payload, &attempts)
	if err == pgx.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}

	handlerErr := w.handlers[queueName](ctx, payload)
	if handlerErr != nil {
		backoff := time.Duration(attempts+1) * 5 * time.Second
		if _, err := tx.Exec(ctx, `
			update job_queue set attempts = attempts + 1, last_error = $2, run_after = now() + $3
			where id = $1`, id, handlerErr.Error(), backoff); err != nil {
			return false, err
		}
	} else if _, err := tx.Exec(ctx,
		`update job_queue set attempts = attempts + 1, done_at = now() where id = $1`, id); err != nil {
		return false, err
	}
	return true, tx.Commit(ctx)
}

// HandlerOptions carries optional integrations for event handlers.
type HandlerOptions struct {
	// OnWorkflowFilesChanged fires when a push touches .github/workflows —
	// the poller uses it for just-in-time discovery rescans.
	OnWorkflowFilesChanged func(repoFullName string)
}

// RegisterDefaultHandlers wires the two ingest queues.
func RegisterDefaultHandlers(w *Worker, pool *pgxpool.Pool, opts ...HandlerOptions) {
	var opt HandlerOptions
	if len(opts) > 0 {
		opt = opts[0]
	}
	w.Handle(QueueGithubEvent, func(ctx context.Context, payload json.RawMessage) error {
		var job GithubEventJob
		if err := json.Unmarshal(payload, &job); err != nil {
			log.Printf("[github] undecodable job (dropping): %v", err)
			return nil
		}
		switch job.Event {
		case "workflow_run":
			evt, err := ghevents.ParseWorkflowRunEvent(job.Payload)
			if err != nil {
				// Schema drift is an alert, not a crash: raw delivery is kept.
				log.Printf("[github] workflow_run failed validation (delivery %s): %v", job.DeliveryID, err)
				return nil
			}
			if _, err := ghevents.ProcessWorkflowRun(ctx, pool, evt); err != nil {
				return err
			}
		case "pull_request":
			evt, err := ghevents.ParsePullRequestEvent(job.Payload)
			if err != nil {
				log.Printf("[github] pull_request failed validation (delivery %s): %v", job.DeliveryID, err)
				return nil
			}
			if err := ghevents.ProcessPullRequest(ctx, pool, evt); err != nil {
				return err
			}
		case "push":
			var evt ghevents.PushEvent
			if err := json.Unmarshal(job.Payload, &evt); err == nil &&
				evt.TouchesWorkflows() && opt.OnWorkflowFilesChanged != nil &&
				evt.Repository != nil && evt.Repository.FullName != nil {
				opt.OnWorkflowFilesChanged(*evt.Repository.FullName)
			}
		}
		// Remaining events land raw in webhook_delivery for later phases.
		if job.DeliveryID != "" {
			_, err := pool.Exec(ctx,
				`update webhook_delivery set processed_at = now() where delivery_id = $1`, job.DeliveryID)
			return err
		}
		return nil
	})

	w.Handle(QueueOtlpMetrics, func(ctx context.Context, payload json.RawMessage) error {
		var job OtlpMetricsJob
		if err := json.Unmarshal(payload, &job); err != nil {
			log.Printf("[otlp] undecodable job (dropping): %v", err)
			return nil
		}
		for _, batch := range job.Batches {
			if _, err := correlate.ApplyBatch(ctx, pool, batch, "otel"); err != nil {
				return err
			}
		}
		return nil
	})
}
