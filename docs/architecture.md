# Scuttledeck architecture

Scuttledeck joins three data planes that each hold a partial picture of an
org's Claude Code GitHub Action usage — GitHub events, OpenTelemetry from CI
runners, and provider billing APIs — into one Postgres store, and serves it
as a fleet dashboard. The join between a GitHub workflow run and its agent
session (with true token cost) is the core of the product.

## System overview

```
                      ┌──────────────────────────────────────────────┐
GitHub (webhooks) ───▶│                                              │
                      │  ingest (Go, single static binary)           │
CI runners (OTLP) ───▶│   /webhooks/github   HMAC-verified           │
                      │   /v1/otlp/metrics   bearer-token verified   │──▶ Postgres 16
Anthropic Admin API ◀─│   pollers: discovery · analytics ·           │        │
LiteLLM gateway    ◀─┤   cost report · LiteLLM spend ·               │        ▼
GitHub REST        ◀─┤   redelivery sweep · alert engine · retention │   dashboard (Next.js)
                      └──────────────────────────────────────────────┘   alert notifications → Slack
```

Two long-running services:

| Service | Runtime | Role |
|---|---|---|
| **ingest** (`cmd/ingest`) | Go, ~15 MB image | Webhook + OTLP receiver, job queue workers, all pollers, alert engine, DB migrations on boot |
| **web** (`apps/web`) | Next.js (Node) | Read-only dashboard; queries Postgres directly via server components; session-cookie auth |

Postgres is the only stateful dependency — queue, correlation state, and
metrics all live there. No Redis, no broker, no sidecar.

## Ingestion planes

### 1. GitHub events (real-time)

`POST /webhooks/github` accepts org-, repo-, or GitHub App-level webhook
deliveries. Processing is two-phase for fast acknowledgment:

1. **Receive** (request path): verify the `X-Hub-Signature-256` HMAC over the
   raw body (env secret or any registered GitHub App secret, constant-time
   comparison), persist the raw delivery keyed by GitHub's delivery GUID
   (replay-safe: duplicates are acknowledged, never reprocessed), enqueue a
   job, return `202`.
2. **Normalize** (worker): `workflow_run` events upsert repo and run rows
   and record review interactions; `pull_request` events maintain the PR
   lifecycle table (author, state, merged); `push` events touching
   `.github/workflows/` and installation events trigger a discovery rescan.
   Unknown or drifted payloads are logged and skipped — raw deliveries are
   retained (`RETENTION_DAYS`), so a fixed normalizer can be replayed.

### 2. OpenTelemetry from CI runners (per-run economics)

The [`scuttledeck/setup`](https://github.com/scuttledeck/setup) composite
action enables Claude Code's built-in OTel export and injects GitHub context
(`github.repo`, `github.run_id`, PR number) as resource attributes.
`POST /v1/otlp/metrics` (and the standard `/v1/metrics` path) authenticates
the bearer token by SHA-256 hash lookup, parses OTLP JSON tolerantly, and
extracts only `claude_code.*` numeric data points carrying a `session.id`.
Logs and traces endpoints acknowledge and discard — nothing resembling
content is ever stored.

Counter handling is temporality-aware: the `session_metric` accumulator
takes the max of cumulative sums and adds deltas, keyed by
(session, metric, type, model). Re-delivered exports can never double-count;
session rollups (tokens by type, cost, model) are recomputed from the
accumulator on every ingest.

### 3. Billing pollers (reconciliation)

All env-gated; absent credentials disable a plane silently:

| Poller | Source | Output |
|---|---|---|
| Analytics (hourly) | Anthropic Admin API `usage_report/claude_code` | per-actor per-day per-model tokens + estimated cost → `cost_daily` |
| Cost report (daily) | Anthropic Admin API `cost_report` | billing-accurate org totals → `cost_daily.billed_cost_usd` |
| LiteLLM spend (daily) | gateway `/global/spend/report` | billed daily totals for deployments with no Anthropic invoice |

The Cost view reconciles per-run estimates against billed totals and shows
drift percentages, with every figure labeled by provenance.

## The correlator

`internal/correlate` joins agent sessions to workflow runs bidirectionally,
so ingestion order never matters:

- **Session-side** (on OTLP ingest): a `github.run_id` resource attribute is
  an exact match once the run row exists; if the run hasn't arrived, the
  session waits — heuristics never override a pending exact hint. Sessions
  without a run-id hint fall back to a repo + time-window heuristic.
- **Run-side** (on webhook ingest): a freshly upserted run claims any
  waiting session whose hint names it (upgrading heuristic matches to
  exact), then sweeps hintless unmatched sessions in the repo whose observed
  lifetime overlaps the run window.

Every session carries a `confidence` flag (`exact` / `heuristic` /
`unmatched`) that the dashboard surfaces on every dollar figure.

## Job queue

`internal/queue` is a Postgres table drained with
`SELECT … FOR UPDATE SKIP LOCKED`: multi-replica safe by construction,
bounded retries with linear backoff, failed jobs retained for inspection.
Workers run inside the ingest process; scaling ingest replicas scales
workers with no coordination required.

## GitHub authentication

Two modes, resolved at poll time:

- **GitHub App** (recommended): created in two clicks via the manifest flow
  (`GET /setup/github`, gated by the ingest token; single-use state ties the
  callback to a page this instance served). The app is read-only by
  construction — GitHub enforces the permission set. Discovery and
  redelivery mint short-lived installation tokens from an RS256 app JWT;
  webhooks arrive app-signed; installation events maintain the installation
  registry automatically.
- **PAT** (`GITHUB_TOKEN`): a read-only token applied to configured orgs;
  suitable for single-org pilots with manually created webhooks.

## Resilience model

| Failure | Behavior |
|---|---|
| Ingest pod restarts | Accepted work is durable (raw delivery + queue rows); workers resume. Kubernetes restarts the pod; ≥2 replicas make it a non-event |
| Webhook missed during downtime | GitHub does not retry; the **redelivery sweeper** (boot + every 30 min) lists deliveries on hooks pointing at this instance and redelivers any failure whose GUID never landed — redeliveries keep their GUID, so success self-limits the sweep |
| OTLP export missed mid-run | Cumulative counters self-heal: the next export carries totals-so-far |
| CI job ends during downtime | Final export lost; the Analytics poller backstops daily totals |
| External API schema drift | Tolerant parsers log and skip records; pollers and normalizers never crash on drift |

## Data model

Core tables (`internal/db/migrations`, applied by the ingest on boot;
`packages/db/schema.ts` mirrors them for the dashboard's typed reads):

`installation` (org, hashed ingest token) → `repo` → `workflow` (discovered
claude-code-action usage, version for drift detection) and `run` (normalized
workflow runs). `agent_session` + `session_metric` hold telemetry and its
accumulator. `pull_request` + `pr_interaction` power outcome metrics
(merge rate of reviewed PRs, cost per review). `cost_daily` holds poller
output for reconciliation. `alert_rule` + `alert_event` drive the alert
engine. `github_app` + `setup_state` support the App flow. `webhook_delivery`
retains raw events; `job_queue` is the work queue.

## Security posture

- **Metadata only.** Prompt and code content are never stored: OTLP
  extraction keeps numeric `claude_code.*` points only; log/trace bodies are
  dropped at the door; GitHub events carry no content.
- **Read-only GitHub access, forever** — enforced by App permissions.
- **Every inbound data path is authenticated**: webhook HMAC (env or
  app secrets), hashed bearer tokens for telemetry (raw tokens never
  stored, rotatable from the Settings UI). Unauthenticated surface:
  `/healthz` and the discard endpoints.
- **Dashboard auth**: shared password (generated at deploy, printed by
  `helm install`), HMAC-signed httpOnly session cookies with configurable
  TTL. SSO/OIDC is the planned upgrade.
- Deploy hardening (TLS, LB source-range allowlists, private dashboard) is
  documented in [deploy-kubernetes.md](deploy-kubernetes.md#production-hardening).

## Repository layout

```
cmd/ingest, cmd/seed        service entrypoints
internal/httpapi            webhook + OTLP + setup-flow handlers
internal/otlp               OTLP parsing and claude_code.* extraction
internal/correlate          the run↔session join
internal/ghevents           webhook payload normalization
internal/discovery          org scanner (workflow YAML, ETag-cached)
internal/queue              SKIP LOCKED job queue + handlers
internal/poller             discovery/analytics/cost/LiteLLM/redelivery/retention schedules
internal/alerts             rule evaluation + Slack
internal/githubapp          manifest flow, app JWT, installation tokens
internal/db                 pool + embedded SQL migrations (schema source of truth)
internal/e2e                integration suite (real Postgres)
apps/web                    Next.js dashboard
packages/db                 typed schema mirror for dashboard reads
charts/scuttledeck          Helm chart
actions/setup               companion action (published as scuttledeck/setup)
```
