import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * One row per GitHub App installation (i.e. one org being monitored).
 * Secrets are never stored raw: the Anthropic Admin API key lives in an
 * external secret ref, and ingest tokens are stored as SHA-256 hashes.
 */
export const installation = pgTable("installation", {
  id: serial("id").primaryKey(),
  githubInstallId: bigint("github_install_id", { mode: "number" }).unique(),
  org: text("org").notNull().unique(),
  adminApiKeyRef: text("admin_api_key_ref"),
  ingestTokenHash: text("ingest_token_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const repo = pgTable(
  "repo",
  {
    id: serial("id").primaryKey(),
    installationId: integer("installation_id").references(() => installation.id),
    ghRepoId: bigint("gh_repo_id", { mode: "number" }).notNull().unique(),
    fullName: text("full_name").notNull().unique(),
    defaultBranch: text("default_branch"),
    hasAction: boolean("has_action").notNull().default(false),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("repo_installation_idx").on(t.installationId)],
);

/**
 * A workflow file that uses anthropics/claude-code-action (any ref/fork).
 * action_version powers drift detection ("repo X is 3 minors behind").
 */
export const workflow = pgTable(
  "workflow",
  {
    id: serial("id").primaryKey(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repo.id),
    path: text("path").notNull(),
    name: text("name"),
    actionRef: text("action_ref"),
    actionVersion: text("action_version"),
    triggers: jsonb("triggers").$type<string[]>().notNull().default([]),
    modelConfig: jsonb("model_config").$type<Record<string, unknown>>(),
    lastScannedAt: timestamp("last_scanned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("workflow_repo_path_uq").on(t.repoId, t.path)],
);

export const run = pgTable(
  "run",
  {
    id: serial("id").primaryKey(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repo.id),
    ghRunId: bigint("gh_run_id", { mode: "number" }).notNull().unique(),
    ghRunAttempt: integer("gh_run_attempt").notNull().default(1),
    workflowId: integer("workflow_id").references(() => workflow.id),
    workflowPath: text("workflow_path"),
    workflowName: text("workflow_name"),
    triggerEvent: text("trigger_event"),
    actor: text("actor"),
    prNumber: integer("pr_number"),
    headBranch: text("head_branch"),
    headSha: text("head_sha"),
    status: text("status").notNull(),
    conclusion: text("conclusion"),
    htmlUrl: text("html_url"),
    runStartedAt: timestamp("run_started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    durationS: integer("duration_s"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("run_repo_idx").on(t.repoId),
    index("run_started_idx").on(t.runStartedAt),
  ],
);

/**
 * One Claude Code session, sourced from OTel (per-run) or the Analytics API
 * (per-actor per-day). run_id stays NULL until the correlator matches it;
 * gh_run_id_hint carries the resource-attribute run id so a late-arriving
 * webhook can still claim the session.
 */
export const agentSession = pgTable(
  "agent_session",
  {
    id: serial("id").primaryKey(),
    runId: integer("run_id").references(() => run.id),
    sessionId: text("session_id").notNull().unique(),
    repoFullName: text("repo_full_name"),
    ghRunIdHint: bigint("gh_run_id_hint", { mode: "number" }),
    model: text("model"),
    tokIn: bigint("tok_in", { mode: "number" }).notNull().default(0),
    tokOut: bigint("tok_out", { mode: "number" }).notNull().default(0),
    tokCacheRead: bigint("tok_cache_read", { mode: "number" }).notNull().default(0),
    tokCacheCreate: bigint("tok_cache_create", { mode: "number" }).notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    source: text("source").notNull(), // 'otel' | 'analytics_api'
    confidence: text("confidence").notNull().default("unmatched"), // 'exact' | 'heuristic' | 'unmatched'
    resourceAttrs: jsonb("resource_attrs").$type<Record<string, string>>(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("agent_session_run_idx").on(t.runId),
    index("agent_session_hint_idx").on(t.ghRunIdHint),
    index("agent_session_repo_idx").on(t.repoFullName),
  ],
);

/**
 * Raw accumulator for OTel sum data points, keyed by the full attribute set.
 * Claude Code exports monotonic sums; depending on exporter temporality each
 * batch is either a delta (add) or a cumulative total (take the max). Session
 * rollups on agent_session are recomputed from this table, so double-posted
 * batches can never double-count.
 */
export const sessionMetric = pgTable(
  "session_metric",
  {
    sessionId: text("session_id").notNull(),
    metric: text("metric").notNull(),
    attrType: text("attr_type").notNull().default(""),
    model: text("model").notNull().default(""),
    value: numeric("value", { precision: 20, scale: 6 }).notNull().default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.metric, t.attrType, t.model] })],
);

export const prInteraction = pgTable(
  "pr_interaction",
  {
    id: serial("id").primaryKey(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repo.id),
    prNumber: integer("pr_number").notNull(),
    kind: text("kind").notNull(), // 'review' | 'comment' | 'commit' | 'pr_opened'
    author: text("author"),
    runId: integer("run_id").references(() => run.id),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("pr_interaction_repo_pr_idx").on(t.repoId, t.prNumber)],
);

/** Tier-1 economics: Anthropic Claude Code Analytics API, per key per day. */
export const costDaily = pgTable(
  "cost_daily",
  {
    id: serial("id").primaryKey(),
    installationId: integer("installation_id").references(() => installation.id),
    day: timestamp("day", { withTimezone: true }).notNull(),
    apiKeyName: text("api_key_name").notNull(),
    model: text("model").notNull().default(""),
    tokIn: bigint("tok_in", { mode: "number" }).notNull().default(0),
    tokOut: bigint("tok_out", { mode: "number" }).notNull().default(0),
    tokCacheRead: bigint("tok_cache_read", { mode: "number" }).notNull().default(0),
    tokCacheCreate: bigint("tok_cache_create", { mode: "number" }).notNull().default(0),
    sessions: integer("sessions").notNull().default(0),
    estCostUsd: numeric("est_cost_usd", { precision: 12, scale: 6 }),
    billedCostUsd: numeric("billed_cost_usd", { precision: 12, scale: 6 }),
  },
  (t) => [uniqueIndex("cost_daily_uq").on(t.day, t.apiKeyName, t.model)],
);

export const alertRule = pgTable("alert_rule", {
  id: serial("id").primaryKey(),
  installationId: integer("installation_id").references(() => installation.id),
  kind: text("kind").notNull(), // 'budget' | 'cost_anomaly' | 'failure_rate' | 'action_stale'
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const alertEvent = pgTable("alert_event", {
  id: serial("id").primaryKey(),
  ruleId: integer("rule_id")
    .notNull()
    .references(() => alertRule.id),
  firedAt: timestamp("fired_at", { withTimezone: true }).notNull().defaultNow(),
  summary: text("summary").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>(),
});

/**
 * Raw webhook deliveries kept briefly for replay/debugging. Payload is the
 * full GitHub event body — GitHub events contain no prompt/code content.
 */
export const webhookDelivery = pgTable(
  "webhook_delivery",
  {
    id: serial("id").primaryKey(),
    deliveryId: text("delivery_id").notNull().unique(),
    event: text("event").notNull(),
    action: text("action"),
    payload: jsonb("payload").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("webhook_delivery_event_idx").on(t.event)],
);
