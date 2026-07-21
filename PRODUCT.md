# Scuttledeck — PRODUCT.md

## Register

product — dashboard/tool UI. Design serves the data; the join (run ↔ session ↔ dollar) is the product. (The static landing page in `docs/index.html` is the one brand-register surface.)

## Users

Platform/DevOps/AI-infra engineers self-hosting fleet monitoring for the Claude Code GitHub Action across a GitHub org. Expert users, information-dense expectations, keyboard-and-terminal natives. Secondary: engineering managers reading cost/outcome numbers.

## Purpose

One dashboard for an org's agentic CI: which repos run the action, live run status, PRs touched, and what every run actually cost — with provenance on every dollar. "Codecov for agentic CI."

## Brand personality

"Ship's chart room" (light) / "night watch" (dark). Nautical instrument panel: chart-paper ground, deep sea-green ink, teal signal sweeps, tabular monospace numerals. Calm, precise, seaworthy — an instrument you trust on watch, not a marketing surface. Copy voice: crisp naval understatement ("The watch floor", "Every sortie", "All quiet on deck").

## Anti-references

- Generic SaaS admin templates (purple gradients, glassmorphism, hero-metric cards)
- Surveillance vibes: per-person cost is team insight, aggregated by default — never a leaderboard of shame
- Fake precision: every number carries provenance or an honest em-dash; no invented decimals

## Strategic design principles

1. Provenance-labeled numbers everywhere (otel · exact / heuristic / included in subscription).
2. Status is never color-alone — icon + label always; palettes CVD-validated per surface (see globals.css header).
3. Metadata only, never content — the UI must never imply prompts/code are stored.
4. Empty states explain how to get data flowing, not just that none exists.
5. Community project — visible "not affiliated with Anthropic" disclaimer.
