// Package db owns the connection pool and embedded SQL migrations.
package db

import (
	"context"
	"embed"
	"fmt"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

func Connect(ctx context.Context, url string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	cfg.MaxConns = 10
	return pgxpool.NewWithConfig(ctx, cfg)
}

// Migrate applies embedded migrations in lexical order, tracked in
// schema_migrations. Databases whose schema predates the tracking table are
// baselined: when core tables already exist, the initial migration is
// recorded as applied instead of re-run.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	if _, err := pool.Exec(ctx, `create table if not exists schema_migrations (
		name text primary key, applied_at timestamptz not null default now())`); err != nil {
		return err
	}

	entries, err := migrationFS.ReadDir("migrations")
	if err != nil {
		return err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	var baseline bool
	if err := pool.QueryRow(ctx,
		`select exists (select 1 from information_schema.tables where table_schema='public' and table_name='run')`,
	).Scan(&baseline); err != nil {
		return err
	}

	for _, name := range names {
		var done bool
		if err := pool.QueryRow(ctx, `select exists (select 1 from schema_migrations where name=$1)`, name).Scan(&done); err != nil {
			return err
		}
		if done {
			continue
		}
		if baseline && strings.HasPrefix(name, "0000_") {
			if _, err := pool.Exec(ctx, `insert into schema_migrations (name) values ($1)`, name); err != nil {
				return err
			}
			continue
		}
		sqlBytes, err := migrationFS.ReadFile("migrations/" + name)
		if err != nil {
			return err
		}
		// drizzle-kit emits statement-breakpoint markers; harmless to split on.
		for _, stmt := range strings.Split(string(sqlBytes), "--> statement-breakpoint") {
			if strings.TrimSpace(stmt) == "" {
				continue
			}
			if _, err := pool.Exec(ctx, stmt); err != nil {
				return fmt.Errorf("migration %s: %w", name, err)
			}
		}
		if _, err := pool.Exec(ctx, `insert into schema_migrations (name) values ($1)`, name); err != nil {
			return err
		}
	}
	return nil
}
