# scuttledeck Helm chart

Full stack — ingest (GitHub webhooks + OTLP telemetry), dashboard, and an
optional bundled Postgres 16 — in one release.

```bash
helm install scuttledeck oci://ghcr.io/scuttledeck/charts/scuttledeck \
  --namespace scuttledeck --create-namespace \
  --set github.org=your-org \
  --set ingress.enabled=true --set ingress.host=scuttledeck.your.domain
```

Secrets (webhook HMAC, ingest token, DB password) are generated on first
install and persist across upgrades.

Full deployment guide, values reference, and troubleshooting:
[docs/deploy-kubernetes.md](https://github.com/manchal22/scuttledeck/blob/main/docs/deploy-kubernetes.md)
