import Link from "next/link";
import { notFound } from "next/navigation";
import { ProvenanceChip, StatusChip } from "@/components/chips";
import { TokenBars } from "@/components/charts";
import { Panel } from "@/components/panels";
import { duration, usd } from "@/lib/format";
import { runDetail } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) notFound();
  const detail = await runDetail(numericId);
  if (!detail) notFound();

  const { run: r, repoFullName, sessions } = detail;
  const primary = sessions[0];

  return (
    <div className="mx-auto max-w-4xl">
      <nav className="font-mono-data mb-5 text-[0.72rem] text-ink-faint">
        <Link href="/runs" className="hover:text-signal-deep hover:underline">runs</Link>
        {" / "}
        <span>{r.ghRunId}</span>
      </nav>

      <header className="mb-6">
        <p className="font-mono-data text-[0.7rem] text-ink-faint">{repoFullName}</p>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="font-display text-[1.6rem] font-bold tracking-tight">
            {r.workflowName ?? r.workflowPath ?? `run ${r.ghRunId}`}
          </h1>
          <StatusChip status={r.status} conclusion={r.conclusion} />
        </div>
        <p className="font-mono-data mt-2 text-[0.75rem] text-ink-soft">
          {r.triggerEvent ?? "unknown trigger"}
          {r.actor ? ` · by ${r.actor}` : ""}
          {r.prNumber ? ` · PR #${r.prNumber}` : ""}
          {r.headBranch ? ` · ${r.headBranch}` : ""}
          {" · "}
          {duration(r.durationS)}
          {r.htmlUrl && (
            <>
              {" · "}
              <a href={r.htmlUrl} className="text-signal-deep underline" target="_blank" rel="noreferrer">
                view on GitHub ↗
              </a>
            </>
          )}
        </p>
      </header>

      {sessions.length === 0 ? (
        <Panel title="Session economics" meta="no telemetry">
          <p className="text-sm leading-relaxed text-ink-soft">
            No agent session is attached to this run. Either the workflow doesn&apos;t include{" "}
            <code className="font-mono-data">scuttledeck/setup@v1</code>, or telemetry hasn&apos;t arrived yet
            (metrics batch ~60s).
          </p>
        </Panel>
      ) : (
        sessions.map((s) => {
          const hasCost = s.costUsd !== null;
          return (
            <Panel
              key={s.id}
              title="Session economics"
              meta={s.model ?? "model unknown"}
            >
              <div className="mb-5 flex flex-wrap items-baseline gap-x-6 gap-y-2">
                <div>
                  <p className="font-mono-data text-[0.62rem] uppercase tracking-[0.18em] text-ink-faint">cost</p>
                  <p className="font-mono-data text-[2.1rem] leading-tight font-medium">
                    {hasCost ? usd(s.costUsd, 4) : "$0.00"}
                  </p>
                </div>
                <ProvenanceChip source={s.source} confidence={s.confidence} hasCost={hasCost} />
              </div>
              {!hasCost && (
                <p className="mb-4 -mt-2 text-[0.8rem] text-ink-soft">
                  This install authenticates with a Claude subscription — token usage is real, the marginal cost is
                  covered by the plan.
                </p>
              )}
              <TokenBars
                rows={[
                  { label: "input", value: s.tokIn },
                  { label: "output", value: s.tokOut },
                  { label: "cache read", value: s.tokCacheRead },
                  { label: "cache write", value: s.tokCacheCreate },
                ]}
              />
              <dl className="font-mono-data mt-5 grid grid-cols-1 gap-1.5 border-t border-line-soft pt-3 text-[0.72rem] text-ink-soft sm:grid-cols-2">
                <div>
                  <dt className="inline text-ink-faint">session · </dt>
                  <dd className="inline break-all">{s.sessionId}</dd>
                </div>
                <div>
                  <dt className="inline text-ink-faint">correlation · </dt>
                  <dd className="inline">
                    {s.confidence === "exact"
                      ? "run id resource attribute (exact)"
                      : s.confidence === "heuristic"
                        ? "repo + time window (heuristic)"
                        : "unmatched"}
                  </dd>
                </div>
              </dl>
            </Panel>
          );
        })
      )}
    </div>
  );
}
