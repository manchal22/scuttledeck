# Running behind an LLM gateway (LiteLLM, Bedrock, Vertex)

Many orgs don't hit `api.anthropic.com` directly — the Claude Code action
talks to a gateway (LiteLLM proxy, cloud provider endpoint) that holds the
real credentials. Scuttledeck works in this setup, because its per-run
telemetry is **client-side**: Claude Code counts tokens and estimates cost
itself and ships them to *your* Scuttledeck ingest, regardless of where model
traffic goes.

The configuration below is verified against LiteLLM proxying to Vertex AI.

## Workflow configuration

```yaml
- uses: scuttledeck/setup@v1
  with:
    endpoint: https://scuttledeck.your.domain
    token: ${{ secrets.SCUTTLEDECK_TOKEN }}

- uses: anthropics/claude-code-action@v1
  with:
    anthropic_api_key: ${{ secrets.LITELLM_API_KEY }}   # your gateway virtual key
    github_token: ${{ secrets.GITHUB_TOKEN }}
    claude_args: --model vertex_ai/claude-sonnet-4-6    # your gateway's model alias
  env:
    ANTHROPIC_BASE_URL: ${{ vars.LITELLM_BASE_URL }}    # e.g. https://ai-gateway.example.com
    ANTHROPIC_SMALL_FAST_MODEL: vertex_ai/claude-sonnet-4-6
```

Configuration requirements:

1. **Base URL is the Anthropic-compatible root.** Claude Code appends
   `/v1/messages`. If your LiteLLM serves the Anthropic format under a path
   prefix, include the prefix.
2. **Pin the model to your gateway's alias.** The action's default model name
   likely doesn't exist on the gateway; without `claude_args: --model …` the
   run fails on the first API call.
3. **Pin the small/fast model too** (`ANTHROPIC_SMALL_FAST_MODEL`) — Claude
   Code uses a second, cheaper model for background work, whose default alias
   may not exist on your gateway either.
4. **GitHub-hosted runners must be able to reach the gateway.** An
   internal-only gateway needs self-hosted runners.

## What each cost tier gives you behind a gateway

| Tier | Direct Anthropic API | Via gateway → Anthropic | Via gateway → Bedrock/Vertex |
|---|---|---|---|
| T2 · OTel per-run (flagship) | ✅ exact tokens + estimate | ✅ | ✅ |
| T1 · Anthropic Analytics API | ✅ per-key daily | ⚠️ all traffic lumped under the gateway's key | ❌ no Anthropic trail |
| T3 · Anthropic cost report | ✅ invoice reconciliation | ✅ org totals | ❌ reconcile against gateway/provider billing |

Notes on the OTel estimate: `claude_code.cost.usage` is computed by Claude
Code from its model pricing table. When the gateway bills provider list
prices, this matches the gateway's own spend accounting. If the gateway
applies custom pricing or markups, treat the OTel figure as list-price cost;
reconciliation against LiteLLM's `/spend/logs` is on the roadmap.

The `model` attribute arrives as your gateway alias (e.g.
`vertex_ai/claude-sonnet-4-6`), and that's what dashboards display —
model-level rollups group by alias.
