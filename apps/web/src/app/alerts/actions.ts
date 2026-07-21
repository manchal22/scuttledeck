"use server";

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

const KIND_DEFAULTS: Record<string, Record<string, number>> = {
  budget: { monthly_usd: 500, warn_fraction: 0.8 },
  cost_anomaly: { multiplier: 3, trailing_days: 7 },
  failure_rate: { threshold: 0.3, window_hours: 24, min_runs: 5 },
  action_stale: { days: 14 },
};

export async function createRule(formData: FormData) {
  const kind = String(formData.get("kind") ?? "");
  const defaults = KIND_DEFAULTS[kind];
  if (!defaults) return;

  const config: Record<string, unknown> = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    const raw = formData.get(key);
    const n = raw !== null && raw !== "" ? Number(raw) : NaN;
    config[key] = Number.isFinite(n) ? n : fallback;
  }
  const slack = String(formData.get("slack_webhook_url") ?? "").trim();
  if (slack.startsWith("https://")) config["slack_webhook_url"] = slack;

  await db().execute(sql`
    insert into alert_rule (kind, config, enabled)
    values (${kind}, ${JSON.stringify(config)}, true)`);
  revalidatePath("/alerts");
}

export async function toggleRule(formData: FormData) {
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return;
  await db().execute(sql`update alert_rule set enabled = not enabled where id = ${id}`);
  revalidatePath("/alerts");
}

export async function deleteRule(formData: FormData) {
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return;
  await db().execute(sql`delete from alert_event where rule_id = ${id}`);
  await db().execute(sql`delete from alert_rule where id = ${id}`);
  revalidatePath("/alerts");
}
