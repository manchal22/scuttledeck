import Link from "next/link";
import { StatusChip } from "@/components/chips";
import { EmptyState, Panel } from "@/components/panels";
import { compactTokens, duration, relativeTime, usd } from "@/lib/format";
import { filterOptions, runsList } from "@/lib/queries";

export const dynamic = "force-dynamic";

const STATUS_OPTIONS = ["success", "failure", "in_progress", "queued"] as const;

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; repo?: string; event?: string }>;
}) {
  const params = await searchParams;
  const filters = {
    status: params.status || undefined,
    repo: params.repo || undefined,
    event: params.event || undefined,
  };
  const [rows, options] = await Promise.all([runsList(filters, 100), filterOptions()]);

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-7">
        <p className="font-mono-data text-[0.65rem] uppercase tracking-[0.22em] text-ink-faint">
          runs · explorer
        </p>
        <h1 className="font-display mt-1 text-[1.9rem] font-bold tracking-tight">Every sortie</h1>
      </header>

      {/* filter row — one row above the charts/tables, per interaction spec */}
      <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="font-mono-data mb-1 block text-[0.62rem] uppercase tracking-[0.16em] text-ink-faint">status</span>
          <select
            name="status"
            defaultValue={filters.status ?? ""}
            className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm"
          >
            <option value="">all</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{s.replace("_", " ")}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="font-mono-data mb-1 block text-[0.62rem] uppercase tracking-[0.16em] text-ink-faint">repo</span>
          <select
            name="repo"
            defaultValue={filters.repo ?? ""}
            className="max-w-56 rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm"
          >
            <option value="">all</option>
            {options.repos.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="font-mono-data mb-1 block text-[0.62rem] uppercase tracking-[0.16em] text-ink-faint">trigger</span>
          <select
            name="event"
            defaultValue={filters.event ?? ""}
            className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm"
          >
            <option value="">all</option>
            {options.events.map((e) => (
              <option key={e} value={e}>{e}</option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="rounded-md bg-signal px-4 py-1.5 text-sm font-medium text-white hover:bg-signal-deep"
        >
          Apply
        </button>
        {(filters.status || filters.repo || filters.event) && (
          <Link href="/runs" className="py-1.5 text-sm text-ink-soft underline">
            clear
          </Link>
        )}
      </form>

      {rows.length === 0 ? (
        <EmptyState title="No runs match">
          <p>Adjust the filters, or wait for the next webhook delivery.</p>
        </EmptyState>
      ) : (
        <Panel title="Runs" meta={`${rows.length} shown`}>
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
        </Panel>
      )}
    </div>
  );
}
