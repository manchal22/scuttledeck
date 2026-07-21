import { sql } from "drizzle-orm";
import { db } from "./db";

/** Raw-SQL insight queries for the PR, Cost, Alerts, and Settings views. */

async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  const res = await db().execute(q);
  return res.rows as T[];
}

export interface PrKpis {
  reviewedPrs: number;
  closedReviewed: number;
  mergedReviewed: number;
  totalReviewCost: number;
  reviews: number;
}

export async function prKpis(): Promise<PrKpis> {
  const [r] = await rows<PrKpis & Record<string, unknown>>(sql`
    with reviewed as (
      select distinct i.repo_id, i.pr_number
      from pr_interaction i where i.kind = 'review'
    ),
    outcomes as (
      select r.repo_id, r.pr_number, p.state, p.merged
      from reviewed r left join pull_request p
        on p.repo_id = r.repo_id and p.pr_number = r.pr_number
    )
    select
      (select count(*) from reviewed)::int as "reviewedPrs",
      (select count(*) from outcomes where state = 'closed')::int as "closedReviewed",
      (select count(*) from outcomes where merged)::int as "mergedReviewed",
      coalesce((
        select sum(s.cost_usd) from pr_interaction i
        join agent_session s on s.run_id = i.run_id
        where i.kind = 'review'
      ), 0)::float as "totalReviewCost",
      (select count(*) from pr_interaction where kind = 'review')::int as "reviews"
  `);
  return r!;
}

export interface ReviewedPr {
  repoFullName: string;
  prNumber: number;
  author: string | null;
  title: string | null;
  state: string;
  merged: boolean;
  reviews: number;
  costUsd: number | null;
  lastReviewAt: Date | null;
}

export async function reviewedPrs(limit = 50): Promise<ReviewedPr[]> {
  return rows<ReviewedPr>(sql`
    select
      r.full_name as "repoFullName",
      i.pr_number as "prNumber",
      max(p.author) as "author",
      max(p.title) as "title",
      coalesce(max(p.state), 'open') as "state",
      bool_or(coalesce(p.merged, false)) as "merged",
      count(*) filter (where i.kind = 'review')::int as "reviews",
      sum(s.cost_usd)::float as "costUsd",
      max(i.occurred_at) as "lastReviewAt"
    from pr_interaction i
    join repo r on r.id = i.repo_id
    left join pull_request p on p.repo_id = i.repo_id and p.pr_number = i.pr_number
    left join agent_session s on s.run_id = i.run_id
    where i.kind = 'review'
    group by r.full_name, i.pr_number
    order by max(i.occurred_at) desc
    limit ${limit}
  `);
}

export interface AuthorStat {
  author: string;
  prs: number;
  reviews: number;
  costUsd: number;
  merged: number;
}

/** PR authors whose PRs consumed the most review spend. */
export async function topAuthors(limit = 10): Promise<AuthorStat[]> {
  return rows<AuthorStat>(sql`
    select
      p.author as "author",
      count(distinct (p.repo_id, p.pr_number))::int as "prs",
      count(i.id)::int as "reviews",
      coalesce(sum(s.cost_usd), 0)::float as "costUsd",
      count(distinct (p.repo_id, p.pr_number)) filter (where p.merged)::int as "merged"
    from pull_request p
    join pr_interaction i on i.repo_id = p.repo_id and i.pr_number = p.pr_number and i.kind = 'review'
    left join agent_session s on s.run_id = i.run_id
    where p.author is not null
    group by p.author
    order by "costUsd" desc, "reviews" desc
    limit ${limit}
  `);
}

export interface LabeledSpend {
  label: string;
  costUsd: number;
  tokens: number;
}

export async function spendBy(dimension: "model" | "workflow" | "day", days = 30): Promise<LabeledSpend[]> {
  const dim =
    dimension === "model"
      ? sql`coalesce(s.model, 'unknown')`
      : dimension === "workflow"
        ? sql`coalesce(r.workflow_name, r.workflow_path, 'unknown')`
        : sql`to_char(date_trunc('day', s.first_seen_at), 'MM/DD')`;
  return rows<LabeledSpend>(sql`
    select ${dim} as "label",
      coalesce(sum(s.cost_usd), 0)::float as "costUsd",
      coalesce(sum(s.tok_in + s.tok_out + s.tok_cache_read + s.tok_cache_create), 0)::float as "tokens"
    from agent_session s
    left join run r on r.id = s.run_id
    where s.first_seen_at >= now() - make_interval(days => ${days})
    group by 1
    order by ${dimension === "day" ? sql`1` : sql`2 desc`}
    limit 20
  `);
}

export interface CostKpis {
  mtd: number;
  prevMonth: number;
  avgPerRun: number;
  avgPerReview: number;
}

export async function costKpis(): Promise<CostKpis> {
  const [r] = await rows<CostKpis>(sql`
    select
      coalesce((select sum(cost_usd) from agent_session where first_seen_at >= date_trunc('month', now())), 0)::float as "mtd",
      coalesce((select sum(cost_usd) from agent_session
        where first_seen_at >= date_trunc('month', now()) - interval '1 month'
          and first_seen_at < date_trunc('month', now())), 0)::float as "prevMonth",
      coalesce((select avg(cost_usd) from agent_session where cost_usd is not null and run_id is not null), 0)::float as "avgPerRun",
      coalesce((select avg(s.cost_usd) from pr_interaction i join agent_session s on s.run_id = i.run_id
        where i.kind = 'review' and s.cost_usd is not null), 0)::float as "avgPerReview"
  `);
  return r!;
}

export interface ReconciliationRow {
  day: string;
  estUsd: number;
  billedUsd: number | null;
  driftPct: number | null;
}

/** Estimate-vs-invoice: OTel/Analytics estimates against the cost report. */
export async function reconciliation(days = 14): Promise<ReconciliationRow[]> {
  return rows<ReconciliationRow>(sql`
    with est as (
      select date_trunc('day', first_seen_at) d, sum(cost_usd) v
      from agent_session where cost_usd is not null group by 1
    ),
    billed as (
      select date_trunc('day', day) d, sum(billed_cost_usd) v
      from cost_daily where api_key_name = '__org_total' group by 1
    )
    select to_char(coalesce(est.d, billed.d), 'YYYY-MM-DD') as "day",
      coalesce(est.v, 0)::float as "estUsd",
      billed.v::float as "billedUsd",
      case when billed.v > 0 then ((coalesce(est.v,0) - billed.v) / billed.v * 100)::float end as "driftPct"
    from est full outer join billed on est.d = billed.d
    where coalesce(est.d, billed.d) >= now() - make_interval(days => ${days})
    order by 1 desc
  `);
}

export interface AlertRuleRow {
  id: number;
  kind: string;
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: Date;
  lastFiredAt: Date | null;
  events: number;
}

export async function alertRules(): Promise<AlertRuleRow[]> {
  return rows<AlertRuleRow>(sql`
    select r.id, r.kind, r.config, r.enabled, r.created_at as "createdAt",
      max(e.fired_at) as "lastFiredAt", count(e.id)::int as "events"
    from alert_rule r left join alert_event e on e.rule_id = r.id
    group by r.id order by r.id
  `);
}

export interface AlertEventRow {
  id: number;
  kind: string;
  summary: string;
  firedAt: Date;
}

export async function alertEvents(limit = 25): Promise<AlertEventRow[]> {
  return rows<AlertEventRow>(sql`
    select e.id, r.kind, e.summary, e.fired_at as "firedAt"
    from alert_event e join alert_rule r on r.id = e.rule_id
    order by e.fired_at desc limit ${limit}
  `);
}

export interface InstallationRow {
  id: number;
  org: string;
  hasToken: boolean;
  createdAt: Date;
  repos: number;
}

export async function installations(): Promise<InstallationRow[]> {
  return rows<InstallationRow>(sql`
    select i.id, i.org, (i.ingest_token_hash is not null) as "hasToken",
      i.created_at as "createdAt", count(r.id)::int as "repos"
    from installation i left join repo r on r.installation_id = i.id
    group by i.id order by i.id
  `);
}
