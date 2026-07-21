// The Scuttledeck ingest service: GitHub webhooks + OTLP telemetry in,
// normalized runs and correlated agent sessions out.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/scuttledeck/scuttledeck/internal/db"
	"github.com/scuttledeck/scuttledeck/internal/httpapi"
	"github.com/scuttledeck/scuttledeck/internal/queue"
)

func main() {
	ctx := context.Background()

	databaseURL := os.Getenv("DATABASE_URL")
	webhookSecret := os.Getenv("GITHUB_WEBHOOK_SECRET")
	if databaseURL == "" {
		log.Fatal("DATABASE_URL is required")
	}
	if webhookSecret == "" {
		log.Fatal("GITHUB_WEBHOOK_SECRET is required")
	}

	pool, err := db.Connect(ctx, databaseURL)
	if err != nil {
		log.Fatalf("connect: %v", err)
	}
	if err := db.Migrate(ctx, pool); err != nil {
		log.Fatalf("migrate: %v", err)
	}

	// Bootstrap the default installation from env so a fresh deploy can
	// receive telemetry with zero UI. The raw token is never stored.
	if token := os.Getenv("INGEST_TOKEN"); token != "" {
		org := os.Getenv("GITHUB_ORG")
		if org == "" {
			org = "default"
		}
		if _, err := pool.Exec(ctx, `
			insert into installation (org, ingest_token_hash) values ($1, $2)
			on conflict (org) do update set ingest_token_hash = excluded.ingest_token_hash`,
			org, httpapi.Sha256Hex(token)); err != nil {
			log.Fatalf("bootstrap installation: %v", err)
		}
		log.Printf("[boot] installation %q ready (ingest token hash registered)", org)
	}

	worker := queue.NewWorker(pool, time.Second)
	queue.RegisterDefaultHandlers(worker, pool)
	worker.Start(ctx)

	server := &httpapi.Server{Pool: pool, WebhookSecret: webhookSecret}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8787"
	}
	log.Printf("[boot] scuttledeck ingest listening on :%s", port)
	if err := http.ListenAndServe(":"+port, server.Handler()); err != nil {
		log.Fatal(err)
	}
}
