# scuttledeck

**Fleet monitoring for the Claude Code GitHub Action.** One self-hosted
dashboard for your whole GitHub org: which repos run the agent, live run
status, the PRs it touched, and what every run actually cost.

- Project: https://github.com/manchal22/scuttledeck
- Companion action: [`scuttledeck/setup`](https://github.com/scuttledeck/setup)
- Deploy: `helm install scuttledeck oci://ghcr.io/scuttledeck/charts/scuttledeck`
  or `docker compose up` from the repo

This package currently ships a pointer CLI (`npx scuttledeck` prints the
quick-start). A full CLI — self-host bootstrap, config checks, diagnostics —
is on the roadmap and will live under this name.

> Independent community project — not affiliated with Anthropic.

Apache-2.0
