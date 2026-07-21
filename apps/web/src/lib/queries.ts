import { and, desc, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { agentSession, repo, run, workflow } from "@scuttledeck/db";
import { db } from "./db";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface FleetKpis {
  reposTotal: number;
  reposWithAction: number;
  runs7d: number;
  runsPrev7d: number;
  successRate7d: number | null;
  completed7d: number;
  prsTouched7d: number;
  spendMtd: number;
  tokens7d: number;
}

export async function fleetKpis(): Promise<FleetKpis> {
  const now = Date.now();
  const d7 = new Date(now - 7 * DAY_MS);
  const d14 = new Date(now - 14 * DAY_MS);
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

  // "On watch" = discovery found the action OR telemetry proves it runs
  // (covers deploys where the discovery scanner isn't enabled yet).
  const [repoCounts] = await db()
    .select({
      total: sql<number>`count(*)::int`,
      withAction: sql<number>`count(*) filter (where ${repo.hasAction} or exists (
        select 1 from ${run} r join ${agentSession} s on s.run_id = r.id
        where r.repo_id = ${repo.id}
      ))::int`,
    })
    .from(repo);

  const [runCounts] = await db()
    .select({
      runs7d: sql<number>`count(*) filter (where ${run.runStartedAt} >= ${d7})::int`,
      runsPrev7d: sql<number>`count(*) filter (where ${run.runStartedAt} >= ${d14} and ${run.runStartedAt} < ${d7})::int`,
      completed7d: sql<number>`count(*) filter (where ${run.runStartedAt} >= ${d7} and ${run.status} = 'completed')::int`,
      success7d: sql<number>`count(*) filter (where ${run.runStartedAt} >= ${d7} and ${run.conclusion} = 'success')::int`,
      prs7d: sql<number>`count(distinct (${run.repoId}, ${run.prNumber})) filter (where ${run.runStartedAt} >= ${d7} and ${run.prNumber} is not null)::int`,
    })
    .from(run);

  const [spend] = await db()
    .select({
      mtd: sql<number>`coalesce(sum(${agentSession.costUsd}) filter (where ${agentSession.firstSeenAt} >= ${monthStart}), 0)::float`,
      tokens7d: sql<number>`coalesce(sum(${agentSession.tokIn} + ${agentSession.tokOut}) filter (where ${agentSession.firstSeenAt} >= ${d7}), 0)::float`,
    })
    .from(agentSession);

  return {
    reposTotal: repoCounts?.total ?? 0,
    reposWithAction: repoCounts?.withAction ?? 0,
    runs7d: runCounts?.runs7d ?? 0,
    runsPrev7d: runCounts?.runsPrev7d ?? 0,
    completed7d: runCounts?.completed7d ?? 0,
    successRate7d:
      runCounts && runCounts.completed7d > 0
        ? runCounts.success7d / runCounts.completed7d
        : null,
    prsTouched7d: runCounts?.prs7d ?? 0,
    spendMtd: spend?.mtd ?? 0,
    tokens7d: spend?.tokens7d ?? 0,
  };
}

export interface DayBucket {
  day: string; // YYYY-MM-DD (UTC)
  runs: number;
  failures: number;
}

export async function runsPerDay(days = 14): Promise<DayBucket[]> {
  const since = new Date(Date.now() - days * DAY_MS);
  const rows = await db()
    .select({ startedAt: run.runStartedAt, conclusion: run.conclusion })
    .from(run)
    .where(gte(run.runStartedAt, since));

  const buckets = new Map<string, DayBucket>();
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10);
    buckets.set(day, { day, runs: 0, failures: 0 });
  }
  for (const r of rows) {
    if (!r.startedAt) continue;
    const day = r.startedAt.toISOString().slice(0, 10);
    const b = buckets.get(day);
    if (!b) continue;
    b.runs += 1;
    if (r.conclusion && r.conclusion !== "success") b.failures += 1;
  }
  return [...buckets.values()];
}

export interface RepoSpend {
  repoFullName: string;
  costUsd: number;
  tokens: number;
  sessions: number;
}

export async function spendByRepo(days = 30, limit = 8): Promise<RepoSpend[]> {
  const since = new Date(Date.now() - days * DAY_MS);
  const rows = await db()
    .select({
      repoFullName: sql<string>`coalesce(${agentSession.repoFullName}, 'unattributed')`,
      costUsd: sql<number>`coalesce(sum(${agentSession.costUsd}), 0)::float`,
      tokens: sql<number>`coalesce(sum(${agentSession.tokIn} + ${agentSession.tokOut} + ${agentSession.tokCacheRead} + ${agentSession.tokCacheCreate}), 0)::float`,
      sessions: sql<number>`count(*)::int`,
    })
    .from(agentSession)
    .where(gte(agentSession.firstSeenAt, since))
    .groupBy(sql`coalesce(${agentSession.repoFullName}, 'unattributed')`)
    .orderBy(sql`coalesce(sum(${agentSession.costUsd}), 0) desc`)
    .limit(limit);
  return rows;
}

export interface RunRow {
  id: number;
  ghRunId: number;
  repoFullName: string | null;
  workflowName: string | null;
  workflowPath: string | null;
  triggerEvent: string | null;
  actor: string | null;
  prNumber: number | null;
  status: string;
  conclusion: string | null;
  htmlUrl: string | null;
  runStartedAt: Date | null;
  durationS: number | null;
  costUsd: number | null;
  tokens: number | null;
  confidence: string | null;
  source: string | null;
}

export interface RunFilters {
  status?: string;
  repo?: string;
  event?: string;
  since?: string; // '24h' | '7d' | '30d'
}

const SINCE_MS: Record<string, number> = {
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
};

function runConditions(filters: RunFilters) {
  const conditions = [];
  if (filters.repo) conditions.push(eq(repo.fullName, filters.repo));
  if (filters.event) conditions.push(eq(run.triggerEvent, filters.event));
  if (filters.status === "success" || filters.status === "failure") {
    conditions.push(eq(run.conclusion, filters.status));
  } else if (filters.status === "in_progress" || filters.status === "queued") {
    conditions.push(eq(run.status, filters.status));
  }
  if (filters.since && SINCE_MS[filters.since]) {
    conditions.push(gte(run.runStartedAt, new Date(Date.now() - SINCE_MS[filters.since]!)));
  }
  return conditions;
}

export async function runsCount(filters: RunFilters = {}): Promise<number> {
  const conditions = runConditions(filters);
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(run)
    .leftJoin(repo, eq(run.repoId, repo.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined);
  return row?.n ?? 0;
}

export async function runsList(filters: RunFilters = {}, limit = 50, offset = 0): Promise<RunRow[]> {
  const conditions = runConditions(filters);

  const rows = await db()
    .select({
      id: run.id,
      ghRunId: run.ghRunId,
      repoFullName: repo.fullName,
      workflowName: run.workflowName,
      workflowPath: run.workflowPath,
      triggerEvent: run.triggerEvent,
      actor: run.actor,
      prNumber: run.prNumber,
      status: run.status,
      conclusion: run.conclusion,
      htmlUrl: run.htmlUrl,
      runStartedAt: run.runStartedAt,
      durationS: run.durationS,
      costUsd: sql<number | null>`sum(${agentSession.costUsd})::float`,
      tokens: sql<number | null>`sum(${agentSession.tokIn} + ${agentSession.tokOut})::float`,
      confidence: sql<string | null>`min(${agentSession.confidence})`,
      source: sql<string | null>`min(${agentSession.source})`,
    })
    .from(run)
    .leftJoin(repo, eq(run.repoId, repo.id))
    .leftJoin(agentSession, eq(agentSession.runId, run.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(run.id, repo.fullName)
    .orderBy(desc(sql`coalesce(${run.runStartedAt}, ${run.createdAt})`))
    .limit(limit)
    .offset(offset);
  return rows;
}

export async function runDetail(id: number) {
  const [row] = await db()
    .select({
      run: run,
      repoFullName: repo.fullName,
    })
    .from(run)
    .leftJoin(repo, eq(run.repoId, repo.id))
    .where(eq(run.id, id))
    .limit(1);
  if (!row) return null;

  const sessions = await db()
    .select()
    .from(agentSession)
    .where(eq(agentSession.runId, id));

  return { ...row, sessions };
}

export async function filterOptions() {
  const repos = await db()
    .select({ fullName: repo.fullName })
    .from(repo)
    .orderBy(repo.fullName);
  const events = await db()
    .selectDistinct({ event: run.triggerEvent })
    .from(run)
    .where(isNotNull(run.triggerEvent));
  return {
    repos: repos.map((r) => r.fullName),
    events: events.map((e) => e.event!).filter(Boolean).sort(),
  };
}

export interface InventoryRow {
  repoFullName: string;
  hasAction: boolean;
  workflows: Array<{
    path: string;
    name: string | null;
    actionVersion: string | null;
    triggers: string[];
  }>;
  lastRunAt: Date | null;
  runs30d: number;
}

export async function inventory(): Promise<{ rows: InventoryRow[]; latestVersion: string | null }> {
  const d30 = new Date(Date.now() - 30 * DAY_MS);
  const repos = await db()
    .select({
      id: repo.id,
      fullName: repo.fullName,
      hasAction: repo.hasAction,
      lastRunAt: sql<Date | null>`max(${run.runStartedAt})`,
      runs30d: sql<number>`count(${run.id}) filter (where ${run.runStartedAt} >= ${d30})::int`,
    })
    .from(repo)
    .leftJoin(run, eq(run.repoId, repo.id))
    .groupBy(repo.id, repo.fullName, repo.hasAction)
    .orderBy(desc(sql`count(${run.id})`));

  const workflows = await db().select().from(workflow);
  const byRepo = new Map<number, InventoryRow["workflows"]>();
  const versions: string[] = [];
  for (const w of workflows) {
    const list = byRepo.get(w.repoId) ?? [];
    list.push({
      path: w.path,
      name: w.name,
      actionVersion: w.actionVersion,
      triggers: w.triggers ?? [],
    });
    byRepo.set(w.repoId, list);
    if (w.actionVersion && /^v?\d/.test(w.actionVersion)) versions.push(w.actionVersion);
  }

  const latestVersion =
    versions.sort((a, b) => {
      const pa = a.replace(/^v/, "").split(".").map(Number);
      const pb = b.replace(/^v/, "").split(".").map(Number);
      for (let i = 0; i < 3; i++) {
        const d = (pb[i] ?? 0) - (pa[i] ?? 0);
        if (d !== 0) return d;
      }
      return 0;
    })[0] ?? null;

  return {
    rows: repos.map((r) => ({
      repoFullName: r.fullName,
      hasAction: r.hasAction,
      workflows: byRepo.get(r.id) ?? [],
      lastRunAt: r.lastRunAt ? new Date(r.lastRunAt) : null,
      runs30d: r.runs30d,
    })),
    latestVersion,
  };
}
