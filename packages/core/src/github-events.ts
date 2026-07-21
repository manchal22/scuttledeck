import { eq, sql } from "drizzle-orm";
import { installation, repo, run, type Db } from "@scuttledeck/db";
import { correlateRunArrival } from "./correlator.js";
import type { WorkflowRunEvent } from "./schemas/github.js";

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Normalize a workflow_run webhook into repo + run rows, then let the
 * correlator claim any telemetry sessions already waiting for this run.
 */
export async function processWorkflowRunEvent(
  db: Db,
  evt: WorkflowRunEvent,
): Promise<{ runId: number; ghRunId: number }> {
  const orgName = evt.repository.full_name.split("/")[0] ?? evt.repository.full_name;

  let inst = evt.installation
    ? (
        await db
          .select()
          .from(installation)
          .where(eq(installation.githubInstallId, evt.installation.id))
          .limit(1)
      )[0]
    : undefined;
  if (!inst) {
    [inst] = await db
      .select()
      .from(installation)
      .where(eq(installation.org, orgName))
      .limit(1);
  }
  if (!inst) {
    [inst] = await db
      .insert(installation)
      .values({ org: orgName, githubInstallId: evt.installation?.id ?? null })
      .returning();
  } else if (inst.githubInstallId === null && evt.installation) {
    await db
      .update(installation)
      .set({ githubInstallId: evt.installation.id })
      .where(eq(installation.id, inst.id));
  }

  const [repoRow] = await db
    .insert(repo)
    .values({
      installationId: inst!.id,
      ghRepoId: evt.repository.id,
      fullName: evt.repository.full_name,
      defaultBranch: evt.repository.default_branch ?? null,
    })
    .onConflictDoUpdate({
      target: repo.ghRepoId,
      set: {
        fullName: sql`excluded.full_name`,
        defaultBranch: sql`coalesce(excluded.default_branch, ${repo.defaultBranch})`,
        updatedAt: sql`now()`,
      },
    })
    .returning();

  const wr = evt.workflow_run;
  const runStartedAt = parseDate(wr.run_started_at);
  const completedAt = evt.action === "completed" ? parseDate(wr.updated_at) : null;
  const durationS =
    runStartedAt && completedAt
      ? Math.max(0, Math.round((completedAt.getTime() - runStartedAt.getTime()) / 1000))
      : null;

  const [runRow] = await db
    .insert(run)
    .values({
      repoId: repoRow!.id,
      ghRunId: wr.id,
      ghRunAttempt: wr.run_attempt ?? 1,
      workflowPath: wr.path ?? null,
      workflowName: wr.name ?? null,
      triggerEvent: wr.event ?? null,
      actor: wr.triggering_actor?.login ?? wr.actor?.login ?? null,
      prNumber: wr.pull_requests?.[0]?.number ?? null,
      headBranch: wr.head_branch ?? null,
      headSha: wr.head_sha ?? null,
      status: wr.status ?? "unknown",
      conclusion: wr.conclusion ?? null,
      htmlUrl: wr.html_url ?? null,
      runStartedAt,
      completedAt,
      durationS,
    })
    .onConflictDoUpdate({
      target: run.ghRunId,
      set: {
        ghRunAttempt: sql`excluded.gh_run_attempt`,
        status: sql`excluded.status`,
        conclusion: sql`coalesce(excluded.conclusion, ${run.conclusion})`,
        completedAt: sql`coalesce(excluded.completed_at, ${run.completedAt})`,
        durationS: sql`coalesce(excluded.duration_s, ${run.durationS})`,
        prNumber: sql`coalesce(excluded.pr_number, ${run.prNumber})`,
        runStartedAt: sql`coalesce(excluded.run_started_at, ${run.runStartedAt})`,
        updatedAt: sql`now()`,
      },
    })
    .returning();

  await correlateRunArrival(db, {
    id: runRow!.id,
    ghRunId: runRow!.ghRunId,
    repoFullName: evt.repository.full_name,
    runStartedAt: runRow!.runStartedAt,
    completedAt: runRow!.completedAt,
  });

  return { runId: runRow!.id, ghRunId: runRow!.ghRunId };
}
