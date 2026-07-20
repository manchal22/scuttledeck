#!/usr/bin/env bash
# End-to-end: bring up Postgres via docker compose, run every workspace test
# suite including the ingest integration tests (webhook → queue → correlator).
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose up -d --wait postgres

export DATABASE_URL="${DATABASE_URL:-postgres://scuttledeck:scuttledeck@localhost:5432/scuttledeck}"

pnpm --filter @scuttledeck/core test
pnpm --filter @scuttledeck/ingest test

echo
echo "e2e passed: run + agent_session joined with cost end-to-end."
