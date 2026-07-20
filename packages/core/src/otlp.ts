import type {
  OtlpDataPoint,
  OtlpKeyValue,
  OtlpMetricsRequest,
} from "./schemas/otlp.js";

/** Metric names emitted by Claude Code we roll up into session economics. */
export const METRIC_TOKEN_USAGE = "claude_code.token.usage";
export const METRIC_COST_USAGE = "claude_code.cost.usage";

/** Resource attributes injected by scuttledeck/setup for run correlation. */
export const ATTR_GITHUB_REPO = "github.repo";
export const ATTR_GITHUB_RUN_ID = "github.run_id";
export const ATTR_GITHUB_WORKFLOW = "github.workflow";
export const ATTR_GITHUB_PR_NUMBER = "github.pr_number";

export type Temporality = "delta" | "cumulative";

export interface MetricPoint {
  sessionId: string;
  metric: string;
  /** e.g. token `type` attribute: input | output | cacheRead | cacheCreation */
  attrType: string;
  model: string;
  value: number;
  temporality: Temporality;
}

export interface ExtractedBatch {
  resourceAttrs: Record<string, string>;
  points: MetricPoint[];
}

function attrsToRecord(kvs: OtlpKeyValue[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of kvs ?? []) {
    const v = kv.value;
    if (!v) continue;
    const raw = v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue;
    if (raw !== undefined) out[kv.key] = String(raw);
  }
  return out;
}

function pointValue(dp: OtlpDataPoint): number | undefined {
  if (dp.asDouble !== undefined) return dp.asDouble;
  if (dp.asInt !== undefined) {
    const n = Number(dp.asInt);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Pull every `claude_code.*` numeric data point out of an OTLP export,
 * grouped by resource. Data points without a `session.id` attribute are
 * dropped — without it there is nothing to correlate. Everything else in the
 * payload (other scopes, logs-like blobs) is discarded: metadata only.
 */
export function extractClaudeMetrics(payload: OtlpMetricsRequest): ExtractedBatch[] {
  const batches: ExtractedBatch[] = [];

  for (const rm of payload.resourceMetrics) {
    const resourceAttrs = attrsToRecord(rm.resource?.attributes);
    const points: MetricPoint[] = [];

    for (const sm of rm.scopeMetrics) {
      for (const metric of sm.metrics) {
        if (!metric.name.startsWith("claude_code.")) continue;

        const sum = metric.sum;
        const dataPoints = sum?.dataPoints ?? metric.gauge?.dataPoints ?? [];
        // AGGREGATION_TEMPORALITY_DELTA = 1, _CUMULATIVE = 2 (default assume cumulative)
        const temporality: Temporality =
          sum?.aggregationTemporality === 1 ? "delta" : "cumulative";

        for (const dp of dataPoints) {
          const attrs = attrsToRecord(dp.attributes);
          const sessionId = attrs["session.id"];
          const value = pointValue(dp);
          if (!sessionId || value === undefined) continue;
          points.push({
            sessionId,
            metric: metric.name,
            attrType: attrs["type"] ?? "",
            model: attrs["model"] ?? "",
            value,
            temporality,
          });
        }
      }
    }

    if (points.length > 0) batches.push({ resourceAttrs, points });
  }

  return batches;
}

/** Correlation hints parsed from resource attributes set by scuttledeck/setup. */
export interface GithubHints {
  repoFullName?: string;
  ghRunId?: number;
  prNumber?: number;
  workflow?: string;
}

export function parseGithubHints(resourceAttrs: Record<string, string>): GithubHints {
  const hints: GithubHints = {};
  if (resourceAttrs[ATTR_GITHUB_REPO]) hints.repoFullName = resourceAttrs[ATTR_GITHUB_REPO];
  const runId = Number(resourceAttrs[ATTR_GITHUB_RUN_ID]);
  if (Number.isFinite(runId) && runId > 0) hints.ghRunId = runId;
  const pr = Number(resourceAttrs[ATTR_GITHUB_PR_NUMBER]);
  if (Number.isFinite(pr) && pr > 0) hints.prNumber = pr;
  if (resourceAttrs[ATTR_GITHUB_WORKFLOW]) hints.workflow = resourceAttrs[ATTR_GITHUB_WORKFLOW];
  return hints;
}
