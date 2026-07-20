import PgBoss from "pg-boss";
import { eq } from "drizzle-orm";
import { webhookDelivery, type Db } from "@scuttledeck/db";
import { applyOtlpBatch } from "./correlator.js";
import { processWorkflowRunEvent } from "./github-events.js";
import { workflowRunEventSchema } from "./schemas/github.js";
import type { ExtractedBatch } from "./otlp.js";

export const QUEUE_GITHUB_EVENT = "github-event";
export const QUEUE_OTLP_METRICS = "otlp-metrics";

export interface GithubEventJobData {
  deliveryId?: string;
  event: string;
  payload: unknown;
}

export interface OtlpMetricsJobData {
  installationId: number;
  batches: ExtractedBatch[];
}

export async function createQueue(connectionString: string): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString, schema: "pgboss" });
  boss.on("error", (err) => console.error("[pg-boss]", err));
  await boss.start();
  await boss.createQueue(QUEUE_GITHUB_EVENT);
  await boss.createQueue(QUEUE_OTLP_METRICS);
  return boss;
}

export async function handleGithubEventJob(db: Db, data: GithubEventJobData): Promise<void> {
  if (data.event === "workflow_run") {
    const parsed = workflowRunEventSchema.safeParse(data.payload);
    if (!parsed.success) {
      // Schema drift is an alert, not a crash: keep the raw delivery, skip.
      console.warn(
        `[github] workflow_run payload failed validation (delivery ${data.deliveryId}):`,
        parsed.error.issues.slice(0, 3),
      );
      return;
    }
    await processWorkflowRunEvent(db, parsed.data);
  }
  // Other events (pull_request, issue_comment, push…) land in webhook_delivery
  // raw and get handlers in P1/P2.

  if (data.deliveryId) {
    await db
      .update(webhookDelivery)
      .set({ processedAt: new Date() })
      .where(eq(webhookDelivery.deliveryId, data.deliveryId));
  }
}

export async function handleOtlpMetricsJob(db: Db, data: OtlpMetricsJobData): Promise<void> {
  for (const batch of data.batches) {
    await applyOtlpBatch(db, batch, "otel");
  }
}

/** Attach queue workers. The default deploy runs these in the ingest process. */
export async function startWorkers(boss: PgBoss, db: Db): Promise<void> {
  await boss.work<GithubEventJobData>(
    QUEUE_GITHUB_EVENT,
    { batchSize: 1, pollingIntervalSeconds: 1 },
    async (jobs) => {
      for (const job of jobs) await handleGithubEventJob(db, job.data);
    },
  );
  await boss.work<OtlpMetricsJobData>(
    QUEUE_OTLP_METRICS,
    { batchSize: 1, pollingIntervalSeconds: 1 },
    async (jobs) => {
      for (const job of jobs) await handleOtlpMetricsJob(db, job.data);
    },
  );
}
