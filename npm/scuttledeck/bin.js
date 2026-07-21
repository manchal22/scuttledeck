#!/usr/bin/env node
console.log(`
  scuttledeck 📡  — fleet monitoring for the Claude Code GitHub Action

  Self-hosted dashboard for every agent run in your GitHub org:
  live status, PRs touched, and what each run actually cost.

  Deploy (Kubernetes):
    helm install scuttledeck oci://ghcr.io/scuttledeck/charts/scuttledeck \\
      --set github.org=your-org

  Deploy (Docker Compose):
    git clone https://github.com/manchal22/scuttledeck && cd scuttledeck
    docker compose up -d

  Docs:    https://github.com/manchal22/scuttledeck
  Action:  https://github.com/scuttledeck/setup

  (This package reserves the name and points the way — a full CLI for
  bootstrap and diagnostics is on the roadmap.)
`);
