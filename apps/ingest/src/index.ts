import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { createDb, installation, runMigrations } from "@scuttledeck/db";
import { createQueue, sha256Hex, startWorkers } from "@scuttledeck/core";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!GITHUB_WEBHOOK_SECRET) throw new Error("GITHUB_WEBHOOK_SECRET is required");

const { db } = createDb(DATABASE_URL);
await runMigrations(db);

// Bootstrap the default installation from env so a fresh `docker compose up`
// can receive telemetry with zero UI. The raw token is never stored.
const ingestToken = process.env.INGEST_TOKEN;
const org = process.env.GITHUB_ORG ?? "default";
if (ingestToken) {
  await db
    .insert(installation)
    .values({ org, ingestTokenHash: sha256Hex(ingestToken) })
    .onConflictDoUpdate({
      target: installation.org,
      set: { ingestTokenHash: sha256Hex(ingestToken) },
    });
  console.log(`[boot] installation "${org}" ready (ingest token hash registered)`);
}

const boss = await createQueue(DATABASE_URL);
await startWorkers(boss, db);

const app = buildApp({ db, boss, webhookSecret: GITHUB_WEBHOOK_SECRET });
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[boot] scuttledeck ingest listening on :${info.port}`);
});
