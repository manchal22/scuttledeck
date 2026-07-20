import { createDb, runMigrations } from "./index.js";
import { agentSession, installation, repo, run, workflow } from "./schema.js";

/**
 * Demo/dev seed: a plausible mid-size org two weeks into adopting the action.
 * Deterministic RNG so screenshots are reproducible. Never run in production —
 * it assumes an empty database.
 */

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260720);
const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const { db, pool } = createDb(url);
await runMigrations(db);

const existing = await db.select().from(repo).limit(1);
if (existing.length > 0) {
  console.error("database is not empty — refusing to seed");
  await pool.end();
  process.exit(1);
}

const [inst] = await db
  .insert(installation)
  .values({ org: "harborline", githubInstallId: 71234501 })
  .returning();

const REPOS: Array<{
  name: string;
  hasAction: boolean;
  version?: string;
  triggers?: string[];
  wfName?: string;
  subscription?: boolean;
  activity: number; // relative run volume
}> = [
  { name: "harborline/api-gateway", hasAction: true, version: "v1.4.2", triggers: ["pull_request", "issue_comment"], wfName: "Claude PR Review", activity: 1.0 },
  { name: "harborline/billing", hasAction: true, version: "v1.4.2", triggers: ["issue_comment"], wfName: "Claude Assistant", activity: 0.75 },
  { name: "harborline/web-app", hasAction: true, version: "v1.2.0", triggers: ["pull_request"], wfName: "Claude Review", activity: 0.9 },
  { name: "harborline/etl-pipelines", hasAction: true, version: "v1.4.2", triggers: ["schedule", "workflow_dispatch"], wfName: "Nightly Refactor Scout", subscription: true, activity: 0.35 },
  { name: "harborline/mobile", hasAction: true, version: "v0.9.1", triggers: ["issue_comment"], wfName: "Claude Helper", activity: 0.45 },
  { name: "harborline/infra-terraform", hasAction: false, activity: 0 },
  { name: "harborline/design-tokens", hasAction: false, activity: 0 },
  { name: "harborline/docs-site", hasAction: false, activity: 0 },
];

const MODELS = ["claude-sonnet-5", "claude-sonnet-5", "claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"];
const ACTORS = ["mira-chen", "dev-arjun", "sofia-lund", "jkowalski", "renovate[bot]"];
const DAY = 24 * 60 * 60 * 1000;

let ghRepoId = 900_100_000;
let ghRunId = 16_200_000_000;
let sessionSeq = 0;

for (const r of REPOS) {
  ghRepoId += 17;
  const [repoRow] = await db
    .insert(repo)
    .values({
      installationId: inst!.id,
      ghRepoId,
      fullName: r.name,
      defaultBranch: "main",
      hasAction: r.hasAction,
    })
    .returning();

  if (!r.hasAction) continue;

  await db.insert(workflow).values({
    repoId: repoRow!.id,
    path: `.github/workflows/claude.yml`,
    name: r.wfName ?? "Claude",
    actionRef: `anthropics/claude-code-action@${r.version}`,
    actionVersion: r.version,
    triggers: r.triggers ?? ["issue_comment"],
    modelConfig: { model: "claude-sonnet-5" },
    lastScannedAt: new Date(),
  });

  // ~14 days of runs, weekday-weighted
  for (let d = 13; d >= 0; d--) {
    const dayStart = Date.now() - d * DAY;
    const weekday = new Date(dayStart).getDay();
    const weekdayFactor = weekday === 0 || weekday === 6 ? 0.25 : 1;
    const runsToday = Math.round((2 + rand() * 6) * r.activity * weekdayFactor);
    for (let i = 0; i < runsToday; i++) {
      ghRunId += Math.floor(1 + rand() * 999);
      const startedAt = new Date(dayStart - rand() * 10 * 60 * 60 * 1000);
      const durationS = Math.round(90 + rand() * 600);
      const completedAt = new Date(startedAt.getTime() + durationS * 1000);
      const stillRunning = d === 0 && i === runsToday - 1 && rand() < 0.5;
      const roll = rand();
      const conclusion = stillRunning ? null : roll < 0.82 ? "success" : roll < 0.94 ? "failure" : "cancelled";
      const prNumber = rand() < 0.72 ? Math.floor(100 + rand() * 400) : null;

      const [runRow] = await db
        .insert(run)
        .values({
          repoId: repoRow!.id,
          ghRunId,
          workflowPath: ".github/workflows/claude.yml",
          workflowName: r.wfName ?? "Claude",
          triggerEvent: pick(r.triggers ?? ["issue_comment"]),
          actor: pick(ACTORS),
          prNumber,
          headBranch: prNumber ? `feat/change-${prNumber}` : "main",
          status: stillRunning ? "in_progress" : "completed",
          conclusion,
          htmlUrl: `https://github.com/${r.name}/actions/runs/${ghRunId}`,
          runStartedAt: startedAt,
          completedAt: stillRunning ? null : completedAt,
          durationS: stillRunning ? null : durationS,
        })
        .returning();

      // ~90% of runs shipped telemetry
      if (rand() < 0.9) {
        sessionSeq += 1;
        const model = pick(MODELS);
        const tokIn = Math.round(8_000 + rand() * 90_000);
        const tokOut = Math.round(1_200 + rand() * 18_000);
        const cacheRead = Math.round(tokIn * (2 + rand() * 6));
        const cacheCreate = Math.round(tokIn * (0.1 + rand() * 0.4));
        const cost = r.subscription
          ? null
          : (
              (tokIn / 1e6) * 3 +
              (tokOut / 1e6) * 15 +
              (cacheRead / 1e6) * 0.3 +
              (cacheCreate / 1e6) * 3.75
            ).toFixed(6);
        const confidence = rand() < 0.88 ? "exact" : "heuristic";
        await db.insert(agentSession).values({
          runId: runRow!.id,
          sessionId: `seed-${sessionSeq.toString().padStart(4, "0")}-${ghRunId}`,
          repoFullName: r.name,
          ghRunIdHint: confidence === "exact" ? ghRunId : null,
          model,
          tokIn,
          tokOut,
          tokCacheRead: cacheRead,
          tokCacheCreate: cacheCreate,
          costUsd: cost,
          source: "otel",
          confidence,
          firstSeenAt: startedAt,
          lastSeenAt: stillRunning ? new Date() : completedAt,
        });
      }
    }
  }
}

// one orphan session: telemetry arrived, webhook never did (unmatched state)
await db.insert(agentSession).values({
  sessionId: "seed-orphan-0001",
  repoFullName: "harborline/api-gateway",
  model: "claude-sonnet-5",
  tokIn: 15400,
  tokOut: 3100,
  tokCacheRead: 88000,
  tokCacheCreate: 4100,
  costUsd: "0.212400",
  source: "otel",
  confidence: "unmatched",
  firstSeenAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
  lastSeenAt: new Date(Date.now() - 26 * 60 * 60 * 1000 + 300_000),
});

const runCount = await db.select().from(run);
const sessionCount = await db.select().from(agentSession);
console.log(`seeded: ${REPOS.length} repos, ${runCount.length} runs, ${sessionCount.length} sessions`);
await pool.end();
