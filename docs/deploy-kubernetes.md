# Deploying Scuttledeck on Kubernetes

The Helm chart runs the full stack: ingest (webhooks + telemetry), the
dashboard, and — by default — a bundled Postgres 16. One release, one host,
three pods.

## Prerequisites

- Kubernetes 1.25+ and Helm 3.8+ (OCI registry support)
- An ingress controller (nginx, traefik, …) if you want GitHub and CI runners
  to reach the service — which is the whole point. Without ingress you can
  still explore via port-forward.
- A DNS name pointing at your ingress (e.g. `scuttledeck.your.domain`)

## Install

**From the published chart** (available once a release has been cut):

```bash
helm install scuttledeck oci://ghcr.io/scuttledeck/charts/scuttledeck \
  --namespace scuttledeck --create-namespace \
  --values my-values.yaml
```

**From a source checkout** (works right now):

```bash
git clone https://github.com/manchal22/scuttledeck && cd scuttledeck
helm install scuttledeck ./charts/scuttledeck \
  --namespace scuttledeck --create-namespace \
  --values my-values.yaml
```

A minimal `my-values.yaml`:

```yaml
github:
  org: your-org            # the GitHub org (or user) you're monitoring — required

ingress:
  enabled: true
  className: nginx
  host: scuttledeck.your.domain
  # TLS via cert-manager (recommended — GitHub webhooks require https):
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
  tls:
    - secretName: scuttledeck-tls
      hosts: [scuttledeck.your.domain]
```

Everything else has sane defaults. The webhook HMAC secret, ingest token,
Postgres password, and **dashboard login password** are generated on first
install and persist across upgrades — you never have to manage them unless
you want to. **`helm install` prints the dashboard password in its output**;
every page of the dashboard requires it (session cookie, `/api/logout` to
sign out). Set `web.password` to choose your own.

The ingest is a single static Go binary (typically under 10 MiB resident),
so the chart ships no resource requests by default — set
`ingest.resources`/`web.resources` if your cluster policy requires them.

## After install

**1. Wait for pods** (web stays not-ready for a few seconds while the ingest
pod runs database migrations on first boot):

```bash
kubectl get pods -n scuttledeck -w
```

**2. Retrieve the generated credentials:**

```bash
# webhook secret — goes in the GitHub webhook config
kubectl get secret scuttledeck-secrets -n scuttledeck \
  -o jsonpath='{.data.GITHUB_WEBHOOK_SECRET}' | base64 -d; echo

# ingest token — goes in each repo's SCUTTLEDECK_TOKEN Actions secret
kubectl get secret scuttledeck-secrets -n scuttledeck \
  -o jsonpath='{.data.INGEST_TOKEN}' | base64 -d; echo
```

**3. Wire GitHub** (per repo for now; the GitHub App flow is on the roadmap):

- Repo → Settings → Webhooks → Add: payload URL
  `https://scuttledeck.your.domain/webhooks/github`, content type
  `application/json`, the webhook secret from above, event: **Workflow runs**.
- Repo → Settings → Secrets and variables → Actions: add secret
  `SCUTTLEDECK_TOKEN` (ingest token from above).
- In the workflow, before `anthropics/claude-code-action`:

  ```yaml
  - uses: scuttledeck/setup@v1
    with:
      endpoint: https://scuttledeck.your.domain
      token: ${{ secrets.SCUTTLEDECK_TOKEN }}
  ```

  (Behind a LiteLLM/Bedrock/Vertex gateway? See [gateways.md](gateways.md).)

**4. Open the dashboard** at `https://scuttledeck.your.domain/`. The next
`@claude` run appears in the live feed, and its cost lands ~a minute after
the run completes.

No ingress? Port-forward instead:

```bash
kubectl port-forward svc/scuttledeck-web 3000:3000 -n scuttledeck    # dashboard
kubectl port-forward svc/scuttledeck-ingest 8787:8787 -n scuttledeck # ingest
```

(GitHub webhooks and CI telemetry still need a public URL — a tunnel works
for testing, see the README's local quick start.)

## Values reference

| Key | Default | Notes |
|---|---|---|
| `github.org` | — | **Required.** Org/user being monitored |
| `github.webhookSecret` | auto-generated | Webhook HMAC secret |
| `ingest.token` | auto-generated | Bearer token CI runners send |
| `web.password` | auto-generated | Dashboard login password (printed by helm NOTES) |
| `web.sessionTtlHours` | `168` | Dashboard session lifetime |
| `github.token` | — | Read-only GitHub token: enables the discovery scanner (hourly + on workflow-file pushes) **and the failed-webhook redelivery sweeper** (on boot + every 30 min — turns ingest downtime into delayed arrival instead of data loss) |
| `anthropic.adminKey` | — | Admin API key: enables the Analytics + cost-report pollers |
| `slack.webhookUrl` | — | Incoming webhook for alert notifications |
| `retentionDays` | `30` | Raw webhook delivery retention |
| `ingest.service.type` / `web.service.type` | `ClusterIP` | `LoadBalancer` for a direct address without an ingress controller |
| `ingest.image.repository` | `ghcr.io/scuttledeck/scuttledeck-ingest` | |
| `web.image.repository` | `ghcr.io/scuttledeck/scuttledeck-web` | |
| `*.image.tag` | `latest` | Pin to a release tag in production |
| `postgres.enabled` | `true` | Bundled Postgres 16 StatefulSet |
| `postgres.storage` | `5Gi` | PVC size |
| `postgres.storageClassName` | cluster default | |
| `externalDatabaseUrl` | — | Bring your own Postgres (`postgres.enabled=false`) |
| `ingress.enabled` | `false` | |
| `ingress.host` | `scuttledeck.example.com` | |
| `ingress.className` / `annotations` / `tls` | — | Passed through |
| `imagePullSecrets` | `[]` | For private registries |

Routing when ingress is enabled: `/webhooks` and `/v1` (webhooks + OTLP) go
to the ingest service; everything else goes to the dashboard.

## Operations

**Upgrade** — generated secrets are re-read from the live Secret, never
rotated silently:

```bash
helm upgrade scuttledeck oci://ghcr.io/scuttledeck/charts/scuttledeck \
  -n scuttledeck --values my-values.yaml
```

**Rotate the ingest token** — set it explicitly once, then update the
`SCUTTLEDECK_TOKEN` secret in your repos:

```bash
helm upgrade scuttledeck ... --set ingest.token=$(openssl rand -hex 20)
```

**Bring your own database:**

```yaml
postgres:
  enabled: false
externalDatabaseUrl: postgres://user:pass@your-postgres:5432/scuttledeck
```

**Uninstall:**

```bash
helm uninstall scuttledeck -n scuttledeck
# the Postgres PVC is retained on purpose; delete it to destroy data:
kubectl delete pvc data-scuttledeck-postgres-0 -n scuttledeck
```

## Production hardening

The exposure model that works: **the dashboard stays private, only the
ingest faces the internet — and only to the callers that need it.**

```yaml
web:
  service:
    type: ClusterIP          # port-forward / VPN / internal ingress only

ingest:
  service:
    type: LoadBalancer
    loadBalancerSourceRanges:
      # GitHub's webhook egress (refresh from https://api.github.com/meta → "hooks")
      - 192.30.252.0/22
      - 185.199.108.0/22
      - 140.82.112.0/20
      - 143.55.64.0/20
      # + your runner egress CIDRs (self-hosted runners: your corp NAT;
      #   GitHub-hosted: the "actions" ranges from /meta — they are wide)
```

Everything on the ingest is authenticated anyway (webhook HMAC, hashed
bearer tokens), so the allowlist is defense in depth, not the only lock.

The rest of the checklist:

1. **TLS** — non-negotiable before real traffic: the dashboard password and
   ingest tokens must not ride plaintext. cert-manager + ingress (chart
   supports it), or a TLS-terminating LB.
2. **`ingest.replicas: 2`** — the queue is SKIP LOCKED multi-replica safe;
   with the redelivery sweeper this makes ingest downtime a non-event.
3. **Database** — the bundled Postgres is a single instance with no backups.
   For production point `externalDatabaseUrl` at a managed/HA Postgres, or
   at minimum schedule `pg_dump` of the PVC.
4. **Pin image tags** — run releases, not `latest`
   (`ingest.image.tag`/`web.image.tag`).
5. **Self-hosted runners?** Telemetry can stay entirely inside your network:
   point the `scuttledeck/setup` endpoint at an internal LB/DNS name and
   keep only the webhook path internet-reachable.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `ImagePullBackOff` | Images not published yet, or GHCR package is private — check the package visibility or add `imagePullSecrets` |
| Postgres pod `ImageInspectError` — *"short name mode is enforcing"* | CRI-O-based node runtimes (e.g. Oracle Linux on OKE) reject unqualified image names. The chart default is fully qualified; when overriding `postgres.image`, include the registry (`docker.io/library/…`) |
| ingest pod crash-looping on first install | Postgres not ready yet; it settles once the DB accepts connections (migrations run on ingest boot) |
| web pod not ready | Waits on the database — resolves seconds after ingest completes migrations |
| Webhook deliveries fail with 401 | Webhook secret mismatch — re-read it from the k8s Secret and update the GitHub webhook config |
| Runs appear but no cost | Telemetry can't reach `https://host/v1/otlp/metrics` from the runner, or the repo's `SCUTTLEDECK_TOKEN` doesn't match — check the action log for OTel export errors |
