import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type PgBoss from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentSession,
  createDb,
  installation,
  run,
  runMigrations,
  webhookDelivery,
} from "@scuttledeck/db";
import { createQueue, sha256Hex, startWorkers } from "@scuttledeck/core";
import { buildApp } from "../src/app.js";

/**
 * End-to-end over the real stack: Hono app → pg-boss queue → workers →
 * Postgres. Requires DATABASE_URL (scripts/e2e.sh provides it via docker
 * compose). This is the P0 exit criterion: a webhook-ingested run ends up
 * with its OTel-ingested agent session and true token cost attached.
 */

const DB_URL = process.env.DATABASE_URL;
const WEBHOOK_SECRET = "test-webhook-secret";
const INGEST_TOKEN = "test-ingest-token";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const workflowRunFixture = JSON.parse(
  readFileSync(path.join(fixturesDir, "workflow_run.completed.json"), "utf8"),
);
const otlpFixture = JSON.parse(readFileSync(path.join(fixturesDir, "otlp-metrics.json"), "utf8"));

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

/** A workflow_run payload for a fresh run id, timestamped around `now`. */
function makeWorkflowRunPayload(ghRunId: number, opts: { startedSecondsAgo?: number } = {}) {
  const payload = clone(workflowRunFixture);
  const started = new Date(Date.now() - (opts.startedSecondsAgo ?? 120) * 1000);
  const completed = new Date();
  payload.workflow_run.id = ghRunId;
  payload.workflow_run.url = `https://api.github.com/repos/acme-fixture/api/actions/runs/${ghRunId}`;
  payload.workflow_run.html_url = `https://github.com/acme-fixture/api/actions/runs/${ghRunId}`;
  payload.workflow_run.created_at = started.toISOString();
  payload.workflow_run.run_started_at = started.toISOString();
  payload.workflow_run.updated_at = completed.toISOString();
  return payload;
}

/** An OTLP payload for a given session, optionally without the run-id hint. */
function makeOtlpPayload(sessionId: string, ghRunId: number | null) {
  const payload = clone(otlpFixture);
  const rm = payload.resourceMetrics[0];
  rm.resource.attributes = rm.resource.attributes.filter(
    (kv: { key: string }) => ghRunId !== null || kv.key !== "github.run_id",
  );
  for (const kv of rm.resource.attributes) {
    if (kv.key === "github.run_id") kv.value.stringValue = String(ghRunId);
  }
  for (const sm of rm.scopeMetrics) {
    for (const metric of sm.metrics) {
      for (const dp of metric.sum.dataPoints) {
        for (const kv of dp.attributes) {
          if (kv.key === "session.id") kv.value.stringValue = sessionId;
        }
      }
    }
  }
  return payload;
}

async function waitFor<T>(fn: () => Promise<T | undefined>, what: string, timeoutMs = 15000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== undefined) return result;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe.runIf(!!DB_URL)("ingest end-to-end", () => {
  let db: ReturnType<typeof createDb>["db"];
  let pool: ReturnType<typeof createDb>["pool"];
  let boss: PgBoss;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    ({ db, pool } = createDb(DB_URL!));
    await db.execute(sql`drop schema if exists public cascade`);
    await db.execute(sql`drop schema if exists pgboss cascade`);
    await db.execute(sql`drop schema if exists drizzle cascade`);
    await db.execute(sql`create schema public`);
    await runMigrations(db);
    await db.insert(installation).values({
      org: "acme-fixture",
      githubInstallId: 61234567,
      ingestTokenHash: sha256Hex(INGEST_TOKEN),
    });
    boss = await createQueue(DB_URL!);
    await startWorkers(boss, db);
    app = buildApp({ db, boss, webhookSecret: WEBHOOK_SECRET });
  });

  afterAll(async () => {
    await boss?.stop({ graceful: false });
    await pool?.end();
  });

  async function postWebhook(payload: unknown, opts: { sig?: string; deliveryId?: string } = {}) {
    const body = JSON.stringify(payload);
    return app.request("/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "workflow_run",
        "x-github-delivery": opts.deliveryId ?? crypto.randomUUID(),
        "x-hub-signature-256": opts.sig ?? sign(body),
      },
      body,
    });
  }

  async function postOtlp(payload: unknown, token = INGEST_TOKEN) {
    return app.request("/v1/otlp/metrics", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
  }

  async function findRun(ghRunId: number) {
    const rows = await db.select().from(run);
    return rows.find((r) => r.ghRunId === ghRunId);
  }

  async function findSession(sessionId: string) {
    const rows = await db.select().from(agentSession);
    return rows.find((s) => s.sessionId === sessionId);
  }

  it("rejects webhooks with a bad signature", async () => {
    const res = await postWebhook(workflowRunFixture, { sig: "sha256=" + "0".repeat(64) });
    expect(res.status).toBe(401);
  });

  it("rejects OTLP posts with an unknown token", async () => {
    const res = await postOtlp(otlpFixture, "wrong-token");
    expect(res.status).toBe(401);
  });

  it("persists a signed workflow_run and normalizes it into a run row", async () => {
    const res = await postWebhook(workflowRunFixture);
    expect(res.status).toBe(202);

    const row = await waitFor(() => findRun(16123456789), "run row");
    expect(row.status).toBe("completed");
    expect(row.conclusion).toBe("success");
    expect(row.triggerEvent).toBe("issue_comment");
    expect(row.actor).toBe("octocat-dev");
    expect(row.prNumber).toBe(42);
    expect(row.durationS).toBe(270);
    expect(row.workflowPath).toBe(".github/workflows/claude-review.yml");
  });

  it("acknowledges but does not reprocess a redelivered delivery id", async () => {
    const deliveryId = "dup-delivery-001";
    const first = await postWebhook(workflowRunFixture, { deliveryId });
    const second = await postWebhook(workflowRunFixture, { deliveryId });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({ duplicate: true });
    const deliveries = await db.select().from(webhookDelivery);
    expect(deliveries.filter((d) => d.deliveryId === deliveryId)).toHaveLength(1);
  });

  it("joins OTel cost to the run exactly via the run-id resource attribute (P0 exit)", async () => {
    const res = await postOtlp(otlpFixture);
    expect(res.status).toBe(200);

    const session = await waitFor(async () => {
      const s = await findSession("9f8e7d6c-5b4a-4321-9876-fedcba098765");
      return s?.runId != null ? s : undefined;
    }, "correlated agent session");

    const runRow = await findRun(16123456789);
    expect(session.runId).toBe(runRow!.id);
    expect(session.confidence).toBe("exact");
    expect(session.source).toBe("otel");
    expect(session.model).toBe("claude-sonnet-5");
    expect(session.tokIn).toBe(45123);
    expect(session.tokOut).toBe(8901);
    expect(session.tokCacheRead).toBe(230450);
    expect(session.tokCacheCreate).toBe(12034);
    expect(Number(session.costUsd)).toBeCloseTo(1.234567, 5);
    expect(session.repoFullName).toBe("acme-fixture/api");
  });

  it("never double-counts a re-delivered cumulative OTLP export", async () => {
    const res = await postOtlp(otlpFixture);
    expect(res.status).toBe(200);
    // Give the worker time to process the duplicate before asserting.
    await new Promise((r) => setTimeout(r, 3000));
    const session = await findSession("9f8e7d6c-5b4a-4321-9876-fedcba098765");
    expect(session!.tokIn).toBe(45123);
    expect(Number(session!.costUsd)).toBeCloseTo(1.234567, 5);
  });

  it("correlates telemetry that arrives before the webhook (run-side claim)", async () => {
    const ghRunId = 16999900001;
    const sessionId = "otel-first-session-0001";

    await postOtlp(makeOtlpPayload(sessionId, ghRunId));
    const pending = await waitFor(() => findSession(sessionId), "session row");
    expect(pending.runId).toBeNull();
    expect(pending.confidence).toBe("unmatched");

    await postWebhook(makeWorkflowRunPayload(ghRunId));
    const claimed = await waitFor(async () => {
      const s = await findSession(sessionId);
      return s?.runId != null ? s : undefined;
    }, "run-side claim");
    expect(claimed.confidence).toBe("exact");
    const runRow = await findRun(ghRunId);
    expect(claimed.runId).toBe(runRow!.id);
  });

  it("falls back to a repo+time heuristic when no run-id attribute is present", async () => {
    const ghRunId = 16999900002;
    const sessionId = "hintless-session-0001";

    await postWebhook(makeWorkflowRunPayload(ghRunId, { startedSecondsAgo: 60 }));
    await waitFor(() => findRun(ghRunId), "heuristic-target run");

    await postOtlp(makeOtlpPayload(sessionId, null));
    const session = await waitFor(async () => {
      const s = await findSession(sessionId);
      return s?.runId != null ? s : undefined;
    }, "heuristic correlation");
    expect(session.confidence).toBe("heuristic");
  });

  it("accepts standard OTLP path and drops logs/traces bodies", async () => {
    const alias = await app.request("/v1/metrics", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${INGEST_TOKEN}` },
      body: JSON.stringify({ resourceMetrics: [] }),
    });
    expect(alias.status).toBe(200);

    const logs = await app.request("/v1/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: { stringValue: "secret prompt" } }] }] }] }),
    });
    expect(logs.status).toBe(200);
    // Nothing from the logs payload may be persisted.
    const deliveries = await db.execute(
      sql`select count(*)::int as n from webhook_delivery where payload::text like '%secret prompt%'`,
    );
    expect((deliveries.rows[0] as { n: number }).n).toBe(0);
  });
});

if (!DB_URL) {
  describe("ingest end-to-end", () => {
    it.skip("requires DATABASE_URL (run scripts/e2e.sh)", () => {});
  });
}
