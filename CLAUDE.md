# Scuttledeck

Open-source, self-hosted fleet monitoring for the **Claude Code GitHub Action** (`anthropics/claude-code-action`). One dashboard for an entire GitHub org: which repos run the action, live run status, PRs Claude reviewed/authored, and cost/token usage per run, per repo, per PR. Think "Codecov for agentic CI."

Community project — **not affiliated with Anthropic**. Never use Anthropic branding; keep a disclaimer in the README.

Full design doc (architecture, wireframes, roadmap): https://claude.ai/code/artifact/04d56909-1f55-460e-9f8e-9f9943c73f5e

## Why this exists

Anthropic ships no UI for the action (GitHub is the UI). The Anthropic Console shows org spend but knows nothing about repos/PRs. Community dashboards target local CLI sessions, not CI. Nothing joins GitHub context with cost. That join is this product.

## Verified platform facts — do not re-litigate, do not assume otherwise

These were verified against docs in July 2026. They constrain everything:

1. **The action exposes NO per-run cost/token outputs.** Its only outputs are `conclusion`, `session_id`, and optional user-schema `structured_output`. Per-run economics MUST come from OpenTelemetry.
2. **Claude Code emits OTel** when `CLAUDE_CODE_ENABLE_TELEMETRY=1` + `OTEL_METRICS_EXPORTER=otlp` + `OTEL_EXPORTER_OTLP_ENDPOINT` are set. Key metrics: `claude_code.token.usage`, `claude_code.cost.usage`. Metrics batch ~60s. Prompt/tool content is NOT exported by default — never enable those opt-in flags.
3. **Anthropic Admin APIs** (require an Admin API key `sk-ant-admin01-…`, not a regular key):
   - `GET /v1/organizations/usage_report/claude_code` — Claude Code Analytics: per-actor (`api_actor` = API key name) per-day sessions, per-model tokens, `estimated_cost`, commits/PRs counted. ~1h freshness. Cursor pagination (`page`, limit max 1000).
   - `GET /v1/organizations/usage_report/messages` — token usage, group_by api_key_id/model, buckets 1m/1h/1d.
   - `GET /v1/organizations/cost_report` — billing-accurate USD, daily, for reconciliation.
4. **Subscription-OAuth installs** (action authenticated with a Claude subscription token instead of an API key) have **no cost trail**. First-class UI state: show tokens from OTel, label cost "included in subscription." Not an error.
5. **GitHub has no API to find repos using a given action.** Discovery = list org repos → list workflows per repo → fetch workflow YAML via contents API → parse for `uses: anthropics/claude-code-action` (match any version/fork ref). Use ETag conditional requests aggressively; 5k req/hr limit.
6. **GitHub App webhooks** are the real-time plane: `workflow_run`, `workflow_job`, `pull_request`, `pull_request_review`, `issue_comment`, `installation_repositories`, `push` (rescan changed workflow files only). Read-only permissions: `actions:read`, `contents:read`, `pull_requests:read`, `metadata:read`. Verify HMAC on every delivery.

## Architecture

Three ingestion planes joined in one store:

```
GitHub webhooks ─┐
OTLP from CI ────┼─→ ingest (Go) → SKIP LOCKED job queue → workers (normalize + correlate) → Postgres → Next.js dashboard
Pollers ─────────┘   (GitHub backfill scan · Anthropic Analytics hourly · cost_report daily)          → alert engine → Slack
```

- **Correlator is the heart**: OTel session ↔ GitHub run join via `OTEL_RESOURCE_ATTRIBUTES` (`github.repo`, `github.run_id`, `github.workflow`, PR number) injected by our companion action `scuttledeck/setup@v1`, which users drop in one step before `claude-code-action`. Fallback: repo+time heuristic, stored with `confidence` flag.
- **Cost tiers**: T1 = Analytics API daily per-key (zero workflow changes, works if teams use one API key per repo/team); T2 = OTel per-run (flagship); T3 = cost_report reconciliation (scale estimates to invoice, show drift %).

## Data model (Postgres)

`installation` (github_install_id, org, admin_api_key_ref, ingest_token_hash) · `repo` (has_action, first_seen) · `workflow` (path, action_ref, action_version, triggers[], model_config — powers drift detection) · `run` (gh_run_id, trigger_event, actor, pr_number, status, conclusion, duration_s) · `agent_session` (run_id nullable, session_id, model, tok_in/out/cache_read/cache_create, cost_usd, source ∈ {otel, analytics_api}, confidence) · `pr_interaction` (pr_number, kind ∈ {review, comment, commit, pr_opened}, author, run_id) · `cost_daily` (api_key_name, model, tokens, est_cost_usd, billed_cost_usd) · `alert_rule` / `alert_event`

## Stack (decided — don't reopen)

Backend: **Go** (net/http, pgx). Schema source of truth: **embedded SQL migrations** in `internal/db/migrations` — the ingest binary applies them on boot. Queue: **Postgres `FOR UPDATE SKIP LOCKED` job table** (`internal/queue`) — no Redis, no broker. Dashboard: **Next.js (App Router) + Tailwind**, reading Postgres via `packages/db` — a typed drizzle **mirror** of the schema (update `schema.ts` whenever a Go migration changes tables). Validation: tolerant Go JSON structs on every external payload — log schema drift, never crash. Deploy: **Docker Compose** (`docker compose up` must fully work) and **Helm** (`charts/scuttledeck`, one-command k8s). License: **Apache-2.0**.

Layout:

```
cmd/ingest        # main: webhooks + OTLP server, migrations on boot, workers
cmd/seed          # deterministic demo data
internal/db       # pool + embedded migrations (schema source of truth)
internal/httpapi  # /webhooks/github (HMAC) + /v1/otlp/metrics (bearer token)
internal/otlp     # OTLP JSON parsing + claude_code.* extraction
internal/correlate# the run↔session join (exact + heuristic, both directions)
internal/ghevents # workflow_run normalization
internal/discovery# org scanner (YAML parse, ETag cache)
internal/queue    # SKIP LOCKED job queue + handlers
internal/e2e      # integration suite (needs DATABASE_URL)
apps/web          # Next.js dashboard
packages/db       # drizzle schema mirror for the dashboard's typed reads
actions/setup     # composite action (published mirror: scuttledeck/setup)
charts/scuttledeck# Helm chart
```

## Dashboard views

Fleet (KPI strip: repos active, runs 7d, success rate, PRs reviewed, spend MTD vs budget · live run feed · spend-by-repo leaderboard · inventory table with action-version drift badges) · Runs (filterable explorer + run detail with tokens/cost/linked PR) · Pull Requests (reviewed/commented/authored, outcomes, cost per review) · Cost (by repo/workflow/model/key, unit economics, reconciliation) · Alerts (budget, cost anomaly >N× trailing median, failure-rate spike, action-stale-14d → Slack webhook).

## Security invariants

- Never store prompt or code content — metadata only (counts, costs, durations, statuses, PR numbers). Drop OTLP log bodies at ingest.
- Admin API key + GitHub App private key encrypted at rest; ingest tokens stored hashed, per-installation, revocable.
- Clawboard-class tools die by scope creep into write access: Scuttledeck **never writes to GitHub repos**. Read-only App permissions, forever.

## Roadmap — build in this order

**P0 · Spike — done.** Exit criterion met: a live `claude-code-action` run correlated `exact` with true cost, through an LLM gateway. The e2e suite in `internal/e2e` covers both arrival orders, idempotent re-delivery, and the heuristic fallback. The GitHub App manifest flow moved to P1 (plain webhooks work today). Original checklist:
1. Scaffold monorepo + docker-compose (Postgres + ingest).
2. GitHub App manifest flow; webhook receiver with HMAC verification; persist `workflow_run` events for a test org.
3. Discovery scanner: find workflows using the action in the test org via YAML parse.
4. `actions/setup` composite action exporting the OTel env vars + `OTEL_RESOURCE_ATTRIBUTES` with run id.
5. OTLP/HTTP metrics endpoint (JSON + protobuf); extract token/cost counters + resource attrs.
6. Run `claude-code-action` in a test repo with the setup step; verify the correlator lands one `run` row with its `agent_session` cost attached.
   **Exit: one run visible end-to-end with true token cost. Nothing else matters until this works.**

**P1 · MVP — done.** GitHub App manifest flow shipped (`/setup/github`, ingest-token gated: two clicks create a read-only app whose webhook + short-lived installation tokens replace manual webhooks and PATs; org/repo webhooks + `GITHUB_TOKEN` PAT remain supported). Discovery poller (hourly + on workflow/installation changes), Analytics poller, Fleet/Runs views, Helm chart, docs, v0.1.0 release. Exit: a stranger self-hosts in <30 min.
**P2 · Per-run economics + operability — done.** PR view (lifecycle from `pull_request` webhooks — the org webhook must subscribe to the Pull requests event; merge rate of reviewed PRs, cost/review, cost/merged-PR, spend-by-author as aggregated team insight, never individual surveillance), Cost view (by day/model/workflow, estimate-vs-invoice reconciliation), Settings (token rotation with show-once, `SESSION_TTL_HOURS`), dark mode (palettes CVD-validated per surface), collapsible rail.
**P3 · Operate — done except SSO/OIDC** (shared-password auth serves until a provider is chosen). Shipped: alert engine (budget, cost anomaly vs trailing median, failure-rate spike, action-stale; 15-min evaluation, per-rule cooldowns, Slack via `SLACK_WEBHOOK_URL` or per-rule override), Alerts UI, retention sweep (`RETENTION_DAYS`), multi-installation schema surfaced in Settings.

## Working conventions

- Test against a real throwaway GitHub org + a repo with a real `claude-code-action` workflow; mock Anthropic APIs with recorded fixtures.
- Every external ingest path gets an integration test with a captured real payload.
- Names free as of 2026-07-20: GitHub org + npm `scuttledeck`. Register before publishing anything.
