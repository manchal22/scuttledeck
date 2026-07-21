# scuttledeck/setup

Composite action that turns on Claude Code's built-in OpenTelemetry export and
tags every metric with the GitHub run context (`github.repo`, `github.run_id`,
PR number, …). Your [Scuttledeck](https://github.com/scuttledeck/scuttledeck)
instance uses those resource attributes to join token/cost telemetry to the
exact workflow run — no heuristics needed.

## Usage

Add one step **before** `anthropics/claude-code-action`:

```yaml
- uses: scuttledeck/setup@v1
  with:
    endpoint: https://scuttledeck.internal.example.dev
    token: ${{ secrets.SCUTTLEDECK_TOKEN }}

- uses: anthropics/claude-code-action@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

## What it sets

| Variable | Value |
|---|---|
| `CLAUDE_CODE_ENABLE_TELEMETRY` | `1` |
| `OTEL_METRICS_EXPORTER` | `otlp` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/json` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | your `endpoint` input |
| `OTEL_EXPORTER_OTLP_HEADERS` | `Authorization=Bearer <token>` (masked in logs) |
| `OTEL_METRIC_EXPORT_INTERVAL` | `10000` ms (configurable via `export-interval-ms`) |
| `OTEL_RESOURCE_ATTRIBUTES` | `github.repo`, `github.run_id`, `github.run_attempt`, `github.workflow`, `github.event`, `github.pr_number` |

Only metrics are exported. Claude Code does **not** export prompt or code
content unless explicitly opted in — this action never enables those flags,
and Scuttledeck drops log/trace bodies at ingest regardless.
