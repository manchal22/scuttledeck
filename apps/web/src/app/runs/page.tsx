import Link from "next/link";
import { StatusChip } from "@/components/chips";
import { EmptyState, Panel } from "@/components/panels";
import { compactTokens, duration, relativeTime, usd } from "@/lib/format";
import { filterOptions, runsCount, runsList } from "@/lib/queries";
import { RunsFilters } from "./filters";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; repo?: string; event?: string; since?: string; page?: string }>;
}) {
  const params = await searchParams;
  const filters = {
    status: params.status || undefined,
    repo: params.repo || undefined,
    event: params.event || undefined,
    since: params.since || undefined,
  };
  const page = Math.max(1, Number(params.page) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const [rows, total, options] = await Promise.all([
    runsList(filters, PAGE_SIZE, offset),
    runsCount(filters),
    filterOptions(),
  ]);
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const pageLink = (p: number) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) next.set(k, v);
    if (p > 1) next.set("page", String(p));
    return `/runs${next.size ? `?${next.toString()}` : ""}`;
  };

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-7">
        <p className="font-mono-data text-[0.65rem] uppercase tracking-[0.22em] text-ink-faint">
          runs · explorer
        </p>
        <h1 className="font-display mt-1 text-[1.9rem] font-bold tracking-tight">Every sortie</h1>
      </header>

      <RunsFilters repos={options.repos} events={options.events} />

      {rows.length === 0 ? (
        <EmptyState title="No runs match">
          <p>
            {total === 0 && !Object.values(filters).some(Boolean)
              ? "No runs recorded yet — they appear here as webhooks deliver."
              : "Nothing in this filter combination. Loosen a filter or widen the time window."}
          </p>
        </EmptyState>
      ) : (
        <Panel
          title="Runs"
          meta={`${offset + 1}–${Math.min(offset + rows.length, total)} of ${total}`}
        >
          <table className="w-full text-sm">
            <thead>
              <tr className="font-mono-data text-left text-[0.62rem] uppercase tracking-[0.14em] text-ink-faint">
                <th className="pb-2 font-normal">status</th>
                <th className="pb-2 font-normal">repo / workflow</th>
                <th className="pb-2 font-normal">trigger</th>
                <th className="pb-2 font-normal">actor</th>
                <th className="pb-2 font-normal">PR</th>
                <th className="pb-2 pr-2 text-right font-normal">duration</th>
                <th className="pb-2 pr-2 text-right font-normal">tokens</th>
                <th className="pb-2 pr-2 text-right font-normal">cost</th>
                <th className="pb-2 text-right font-normal">when</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-line-soft hover:bg-signal-wash">
                  <td className="py-2.5 pr-3">
                    <StatusChip status={r.status} conclusion={r.conclusion} />
                  </td>
                  <td className="py-2.5 pr-3">
                    <Link href={`/runs/${r.id}`} className="group">
                      <span className="font-mono-data text-[0.7rem] text-ink-faint">{r.repoFullName}</span>
                      <br />
                      <span className="font-medium group-hover:text-signal-deep group-hover:underline">
                        {r.workflowName ?? r.workflowPath ?? `run ${r.ghRunId}`}
                      </span>
                    </Link>
                  </td>
                  <td className="font-mono-data py-2.5 pr-3 text-[0.72rem] text-ink-soft">{r.triggerEvent ?? "—"}</td>
                  <td className="font-mono-data py-2.5 pr-3 text-[0.72rem] text-ink-soft">{r.actor ?? "—"}</td>
                  <td className="font-mono-data py-2.5 pr-3 text-[0.72rem]">{r.prNumber ? `#${r.prNumber}` : "—"}</td>
                  <td className="font-mono-data py-2.5 pr-2 text-right text-[0.75rem]">{duration(r.durationS)}</td>
                  <td className="font-mono-data py-2.5 pr-2 text-right text-[0.75rem]">
                    {r.tokens ? compactTokens(r.tokens) : "—"}
                  </td>
                  <td className="font-mono-data py-2.5 pr-2 text-right text-[0.75rem]">
                    {r.costUsd != null ? usd(r.costUsd) : "—"}
                  </td>
                  <td className="font-mono-data py-2.5 text-right text-[0.7rem] text-ink-faint">
                    {relativeTime(r.runStartedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {lastPage > 1 && (
            <div className="font-mono-data mt-4 flex items-center justify-between border-t border-line-soft pt-3 text-[0.75rem]">
              {page > 1 ? (
                <Link href={pageLink(page - 1)} className="text-signal-deep underline">← newer</Link>
              ) : (
                <span className="text-ink-faint">← newer</span>
              )}
              <span className="text-ink-faint">page {page} / {lastPage}</span>
              {page < lastPage ? (
                <Link href={pageLink(page + 1)} className="text-signal-deep underline">older →</Link>
              ) : (
                <span className="text-ink-faint">older →</span>
              )}
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}
