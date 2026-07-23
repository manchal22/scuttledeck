<p align="center">
  <img src="docs/logo.svg" width="88" alt="Scuttledeck logo — a deck scuttle as a sonar screen" />
</p>

# Scuttledeck

**Fleet monitoring for the Claude Code GitHub Action.** One self-hosted dashboard for your whole GitHub org: which repos run the agent, live run status, the PRs it reviewed or authored, and what every run actually cost.

![Scuttledeck fleet dashboard](docs/screenshot-fleet.png)

<sub>The Fleet view. Also included: Runs, Pull Requests (merge rate, cost per review), Cost, Alerts, Settings — and a dark "night watch" theme.</sub>

> **Status: v0.1.0 (early).** The core pipeline — GitHub webhooks, OpenTelemetry ingest, and the run↔cost correlator — is verified end-to-end, including deployments behind LLM gateways (LiteLLM / Bedrock / Vertex). Expect rough edges; issues and feedback welcome.

> Scuttledeck is an independent community project. It is **not affiliated with, endorsed by, or supported by Anthropic**.

## The problem

Teams are wiring [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action) into dozens of repos — `@claude` mentions, automated PR review, scheduled maintenance jobs. Each run is an autonomous agent spending real tokens and writing real code. But there's no fleet view:

- **Adoption** — which of your 200 repos actually have the action installed, and on which triggers?
- **Activity** — how many PRs did Claude review this week? How many did it open? What's the failure rate?
- **Cost** — what did agentic CI cost this month, by repo, by workflow, by model? What does one PR review cost?
- **Health** — which workflows are failing, timing out, or burning tokens abnormally?

Today the answer is clicking through GitHub's Actions tab, repo by repo. The Anthropic Console shows org-level spend but knows nothing about repos or PRs. Observability vendors can receive Claude Code's OpenTelemetry metrics, but with no GitHub context and no turnkey story.

Scuttledeck joins the three data planes that each hold a piece of the answer — GitHub events, Claude Code telemetry, and Anthropic's Admin APIs — into one PR-centric, cost-aware dashboard. Think **Codecov for agentic CI**.

## How it works

```
GitHub App webhooks ──┐
OTLP from CI runners ─┼─→ ingest → queue → correlate → Postgres → dashboard + alerts
Anthropic API pollers ┘
```

1. **A read-only GitHub App** delivers real-time run and PR events, and a scanner discovers every workflow in your org that uses the action (GitHub has no API filter for this — Scuttledeck parses workflow YAML with aggressive ETag caching).
2. **A one-line companion step** turns on Claude Code's built-in OpenTelemetry export and tags it with the run ID, so every token and cost counter arrives pre-joined to its exact GitHub run:

   ```yaml
   - uses: scuttledeck/setup@v1
     with:
       endpoint: https://scuttledeck.internal.example.dev
       token: ${{ secrets.SCUTTLEDECK_TOKEN }}
   - uses: anthropics/claude-code-action@v1
     # ...
   ```

3. **Anthropic Admin API pollers** fill in the rest: the Claude Code Analytics API gives per-API-key daily cost with zero workflow changes, and the cost report reconciles estimates against what you're actually billed.

Cost attribution degrades gracefully: no telemetry step → daily per-key costs; no Admin API key (e.g. subscription-authenticated installs) → token counts with cost marked *included in subscription*. Every dollar figure in the UI is labeled with its provenance.

## What you get

| View | Answers |
|---|---|
| **Fleet** | Repos active vs. total, runs & success rate, spend vs. budget, live run feed, action-version drift |
| **Runs** | Filterable run explorer; per-run tokens, cost, duration, trigger, linked PR |
| **Pull requests** | Everything Claude reviewed, commented on, or authored — with outcomes and cost per review |
| **Cost** | Spend by repo / workflow / model / API key; unit economics; estimate-vs-invoice reconciliation |
| **Alerts** | Budgets, cost anomalies, failure-rate spikes, stale installs → Slack or email |

## Security & privacy

- **No prompt or code content is ever stored.** Claude Code's telemetry omits it by default; Scuttledeck never enables the opt-in flags and drops log bodies at ingest. Metadata only: counts, costs, durations, statuses, PR numbers.
- **Read-only, forever.** The GitHub App requests `actions:read`, `contents:read`, `pull_requests:read`, `metadata:read` — Scuttledeck never writes to your repos.
- **Self-hosted by default.** Your telemetry never leaves your network. Secrets (Admin API key, App private key) are encrypted at rest; ingest tokens are hashed and revocable per installation.

## Quick start

*The full turnkey story ships with the MVP (Phase 1).* The goal it will be held to: one command, install the GitHub App, and see your fleet in under 30 minutes.

### Kubernetes (one command)

```bash
helm install scuttledeck oci://ghcr.io/scuttledeck/charts/scuttledeck \
  --set github.org=your-org \
  --set ingress.enabled=true --set ingress.host=scuttledeck.your.domain
```

Bundled Postgres, auto-generated secrets (persisted across upgrades), and a
password-protected dashboard — **helm prints the login password on install**.
Bring your own database with `--set postgres.enabled=false --set
externalDatabaseUrl=…`. Chart source lives in [charts/scuttledeck](charts/scuttledeck);
**full walkthrough — prerequisites, TLS, wiring GitHub, values reference,
troubleshooting — in [docs/deploy-kubernetes.md](docs/deploy-kubernetes.md).**

### Docker Compose

```bash
cp .env.example .env   # set GITHUB_WEBHOOK_SECRET, INGEST_TOKEN, GITHUB_ORG
docker compose up -d   # Postgres + ingest on :8787
```

### Behind an LLM gateway?

LiteLLM / Bedrock / Vertex setups work — per-run telemetry is client-side and
validated against a real LiteLLM→Vertex deployment. See [docs/gateways.md](docs/gateways.md)
for the three configuration rakes and which cost tiers apply.

### Hacking on it locally

```bash
docker compose up -d --wait postgres     # Postgres 16
./scripts/e2e.sh                         # full Go test suite incl. the P0 exit proof

# dashboard with demo data
DATABASE_URL=postgres://scuttledeck:scuttledeck@localhost:5432/scuttledeck \
  go run ./cmd/seed
pnpm install
DATABASE_URL=postgres://scuttledeck:scuttledeck@localhost:5432/scuttledeck \
  pnpm --filter @scuttledeck/web dev     # → http://localhost:3000

# the whole ingest plane in containers
docker compose up -d                     # ingest on :8787
```

## Documentation

| Guide | Covers |
|---|---|
| [Architecture](docs/architecture.md) | The three ingestion planes, the correlator, queue, pollers, resilience model, security posture |
| [Deploy on Kubernetes](docs/deploy-kubernetes.md) | Install, credentials, wiring GitHub, values reference, production hardening, troubleshooting |
| [LLM gateways](docs/gateways.md) | LiteLLM / Bedrock / Vertex configuration and which cost tiers apply |
| [`scuttledeck/setup` action](https://github.com/scuttledeck/setup) | The one workflow step that enables telemetry |
| [Design document](docs/design.html) | Architecture, data model, dashboard wireframes, risk analysis |

## Roadmap

- [x] **P0 — Spike:** webhook ingest, workflow discovery, `scuttledeck/setup@v1`, OTLP endpoint, run↔cost correlator
- [x] **P1 — MVP:** Fleet + Runs views, discovery poller, Anthropic Analytics poller, Helm deploy, v0.1.0 release *(GitHub App install flow pending — org/repo webhooks today)*
- [x] **P2 — Per-run economics:** PR outcomes view, cost-per-review, billing reconciliation, settings
- [x] **P3 — Operate:** alert engine → Slack, retention *(SSO/OIDC pending — password auth today)*

The full architecture — data sources (verified against platform docs), data model, dashboard wireframes, and risk analysis — lives in [docs/design.html](docs/design.html).

## Stack

**Go** ingest & correlator (single ~15 MB static image, embedded SQL migrations, Postgres `SKIP LOCKED` job queue — no Redis) · Postgres 16 · **Next.js** dashboard · Docker Compose + **Helm** deploy.

## Contributing

Not open for contributions quite yet — the P0 spike needs to land first. Issues and design feedback are very welcome in the meantime.

## License

[Apache-2.0](LICENSE)
