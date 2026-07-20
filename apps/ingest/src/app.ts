import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type PgBoss from "pg-boss";
import { installation, webhookDelivery, type Db } from "@scuttledeck/db";
import {
  QUEUE_GITHUB_EVENT,
  QUEUE_OTLP_METRICS,
  extractClaudeMetrics,
  otlpMetricsRequestSchema,
  sha256Hex,
  verifyGithubSignature,
  type GithubEventJobData,
  type OtlpMetricsJobData,
} from "@scuttledeck/core";

export interface AppDeps {
  db: Db;
  boss: PgBoss;
  webhookSecret: string;
}

export function buildApp({ db, boss, webhookSecret }: AppDeps): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));

  /**
   * GitHub App webhook receiver. HMAC is verified over the raw body before
   * anything else; the raw delivery is persisted (replay-safe on delivery id)
   * and normalization happens in a queue worker, so GitHub always gets a
   * fast 2xx.
   */
  app.post("/webhooks/github", async (c) => {
    const rawBody = await c.req.text();
    const signature = c.req.header("x-hub-signature-256");
    if (!verifyGithubSignature(webhookSecret, rawBody, signature)) {
      return c.json({ error: "invalid signature" }, 401);
    }

    const event = c.req.header("x-github-event") ?? "unknown";
    const deliveryId = c.req.header("x-github-delivery") ?? crypto.randomUUID();

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }

    if (event === "ping") return c.json({ ok: true, pong: true });

    const action =
      typeof payload === "object" && payload !== null && "action" in payload
        ? String((payload as { action: unknown }).action)
        : null;

    const inserted = await db
      .insert(webhookDelivery)
      .values({ deliveryId, event, action, payload })
      .onConflictDoNothing({ target: webhookDelivery.deliveryId })
      .returning({ id: webhookDelivery.id });
    if (inserted.length === 0) {
      // Redelivery of an already-seen delivery id — acknowledge, don't reprocess.
      return c.json({ ok: true, duplicate: true }, 202);
    }

    const job: GithubEventJobData = { deliveryId, event, payload };
    await boss.send(QUEUE_GITHUB_EVENT, job);
    return c.json({ ok: true }, 202);
  });

  /**
   * OTLP/HTTP metrics from CI runners, authenticated by per-installation
   * ingest token (only its SHA-256 lives in the DB). Mounted both at the
   * canonical path and at the standard OTLP path that exporters derive from
   * OTEL_EXPORTER_OTLP_ENDPOINT.
   */
  const otlpMetricsHandler = async (c: import("hono").Context) => {
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : null;
    if (!token) return c.json({ error: "missing bearer token" }, 401);

    const [inst] = await db
      .select()
      .from(installation)
      .where(eq(installation.ingestTokenHash, sha256Hex(token)))
      .limit(1);
    if (!inst) return c.json({ error: "unknown ingest token" }, 401);

    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      // scuttledeck/setup pins OTEL_EXPORTER_OTLP_PROTOCOL=http/json.
      return c.json(
        { error: "only application/json OTLP is supported; set OTEL_EXPORTER_OTLP_PROTOCOL=http/json" },
        415,
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }

    const parsed = otlpMetricsRequestSchema.safeParse(body);
    if (!parsed.success) {
      console.warn("[otlp] payload failed validation (schema drift?):", parsed.error.issues.slice(0, 3));
      return c.json({ error: "unrecognized OTLP payload" }, 400);
    }

    // Extraction keeps claude_code.* numeric points only — anything resembling
    // content never reaches the queue or the database.
    const batches = extractClaudeMetrics(parsed.data);
    if (batches.length > 0) {
      const job: OtlpMetricsJobData = { installationId: inst.id, batches };
      await boss.send(QUEUE_OTLP_METRICS, job);
    }
    return c.json({ partialSuccess: {} }, 200);
  };

  app.post("/v1/otlp/metrics", otlpMetricsHandler);
  app.post("/v1/metrics", otlpMetricsHandler);

  // Never store telemetry we don't need: logs/traces are acknowledged and dropped.
  app.post("/v1/logs", (c) => c.json({ partialSuccess: {} }, 200));
  app.post("/v1/traces", (c) => c.json({ partialSuccess: {} }, 200));

  return app;
}
