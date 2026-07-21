#!/usr/bin/env bash
# End-to-end: bring up Postgres via docker compose, run the full Go test
# suite (unit + the ingest e2e: webhook → queue → correlator → cost joined)
# against a dedicated test database.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose up -d --wait postgres
docker compose exec -T postgres psql -U scuttledeck -d scuttledeck \
  -tc "select 1 from pg_database where datname = 'scuttledeck_test'" | grep -q 1 ||
  docker compose exec -T postgres psql -U scuttledeck -d scuttledeck -c 'create database scuttledeck_test'

export DATABASE_URL="${TEST_DATABASE_URL:-postgres://scuttledeck:scuttledeck@localhost:5432/scuttledeck_test}"

go test ./...

echo
echo "e2e passed: run + agent_session joined with cost end-to-end."
