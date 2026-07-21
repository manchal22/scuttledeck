import Link from "next/link";
import { StatusChip, VersionBadge } from "@/components/chips";
import { RunsBarChart, Sparkbars, SpendBars } from "@/components/charts";
import { EmptyState, Panel, StatTile } from "@/components/panels";
import { duration, relativeTime, usd, compactTokens } from "@/lib/format";
import { fleetKpis, inventory, runsList, runsPerDay, spendByRepo } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function FleetPage() {
  const [kpis, days, spend, feed, inv] = await Promise.all([
    fleetKpis(),
    runsPerDay(14),
    spendByRepo(30),
    runsList({}, 10),
    inventory(),
  ]);

  const hasData = kpis.runs7d > 0 || feed.length > 0;
  const runsDelta = kpis.runsPrev7d > 0 ? kpis.runs7d - kpis.runsPrev7d : null;

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-7">
        <p className="font-mono-data text-[0.65rem] uppercase tracking-[0.22em] text-ink-faint">
          fleet · all repos
        </p>
        <h1 className="font-display mt-1 text-[1.9rem] font-bold tracking-tight">
          The watch floor
        </h1>
      </header>

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile
          label="repos on watch"
          value={`${kpis.reposWithAction}`}
          sub={`of ${kpis.reposTotal} scanned`}
        />
        <StatTile
          label="runs · 7d"
          value={kpis.runs7d.toLocaleString()}
          sub={
            runsDelta === null ? "no prior week" : runsDelta >= 0 ? `+${runsDelta} vs prev 7d` : `${runsDelta} vs prev 7d`
          }
          spark={<Sparkbars buckets={days.slice(-7)} width={72} height={24} />}
        />
        <StatTile
          label="success rate · 7d"
          value={kpis.successRate7d === null ? "—" : `${Math.round(kpis.successRate7d * 100)}%`}
          sub={`${kpis.completed7d} completed`}
        />
        <StatTile label="PRs touched · 7d" value={kpis.prsTouched7d.toLocaleString()} sub="reviews, comments, commits" />
        <StatTile
          label="spend · MTD"
          value={usd(kpis.spendMtd)}
          sub={`${compactTokens(kpis.tokens7d)} tokens · 7d`}
        />
      </div>

      {!hasData && (
        <div className="mt-8">
          <EmptyState title="No contacts on the scope yet">
            <p>
              Point a GitHub App webhook at <code className="font-mono-data">/webhooks/github</code> and add{" "}
              <code className="font-mono-data">scuttledeck/setup@v1</code> before{" "}
              <code className="font-mono-data">anthropics/claude-code-action</code> in one workflow. The first run
              will surface here with its true token cost.
            </p>
          </EmptyState>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-5">
        <Panel title="Run volume" meta="14 days" className="xl:col-span-3">
          <RunsBarChart buckets={days} />
          <p className="font-mono-data mt-2 text-[0.65rem] text-ink-faint">
            <span style={{ color: "var(--sd-signal)" }}>■</span> succeeded&ensp;
            <span style={{ color: "var(--sd-crit)" }}>■</span> failed / other
          </p>
        </Panel>

        <Panel title="Spend by repo" meta="30 days" className="xl:col-span-2">
          {spend.length === 0 ? (
            <p className="text-sm text-ink-soft">No telemetry yet — costs appear once a run ships OTel metrics.</p>
          ) : (
            <SpendBars rows={spend} />
          )}
        </Panel>
      </div>

      <div className="mt-4">
        <Panel title="Live run feed" meta={`latest ${feed.length}`}>
          {feed.length === 0 ? (
            <p className="text-sm text-ink-soft">Nothing yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="font-mono-data text-left text-[0.62rem] uppercase tracking-[0.14em] text-ink-faint">
                  <th className="pb-2 font-normal">status</th>
                  <th className="pb-2 font-normal">repo / workflow</th>
                  <th className="pb-2 font-normal">trigger</th>
                  <th className="pb-2 font-normal">PR</th>
                  <th className="pb-2 pr-2 text-right font-normal">duration</th>
                  <th className="pb-2 pr-2 text-right font-normal">cost</th>
                  <th className="pb-2 text-right font-normal">when</th>
                </tr>
              </thead>
              <tbody>
                {feed.map((r) => (
                  <tr key={r.id} className="border-t border-line-soft hover:bg-signal-wash">
                    <td className="py-2.5 pr-3">
                      <StatusChip status={r.status} conclusion={r.conclusion} />
                    </td>
                    <td className="py-2.5 pr-3">
                      <Link href={`/runs/${r.id}`} className="group">
                        <span className="font-mono-data text-[0.72rem] text-ink-faint">{r.repoFullName}</span>
                        <br />
                        <span className="font-medium group-hover:text-signal-deep group-hover:underline">
                          {r.workflowName ?? r.workflowPath ?? `run ${r.ghRunId}`}
                        </span>
                      </Link>
                    </td>
                    <td className="font-mono-data py-2.5 pr-3 text-[0.75rem] text-ink-soft">{r.triggerEvent ?? "—"}</td>
                    <td className="font-mono-data py-2.5 pr-3 text-[0.75rem] text-ink-soft">
                      {r.prNumber ? `#${r.prNumber}` : "—"}
                    </td>
                    <td className="font-mono-data py-2.5 pr-2 text-right text-[0.78rem]">{duration(r.durationS)}</td>
                    <td className="font-mono-data py-2.5 pr-2 text-right text-[0.78rem]">
                      {r.costUsd != null ? usd(r.costUsd) : r.tokens ? `${compactTokens(r.tokens)} tok` : "—"}
                    </td>
                    <td className="font-mono-data py-2.5 text-right text-[0.72rem] text-ink-faint">
                      {relativeTime(r.runStartedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <div className="mt-4">
        <Panel title="Inventory" meta="action installs & version drift">
          {inv.rows.length === 0 ? (
            <p className="text-sm text-ink-soft">No repos discovered yet — the scanner fills this in.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="font-mono-data text-left text-[0.62rem] uppercase tracking-[0.14em] text-ink-faint">
                  <th className="pb-2 font-normal">repo</th>
                  <th className="pb-2 font-normal">workflow</th>
                  <th className="pb-2 font-normal">triggers</th>
                  <th className="pb-2 font-normal">action version</th>
                  <th className="pb-2 pr-2 text-right font-normal">runs · 30d</th>
                  <th className="pb-2 text-right font-normal">last run</th>
                </tr>
              </thead>
              <tbody>
                {inv.rows
                  .filter((r) => r.hasAction || r.workflows.length > 0)
                  .map((r) =>
                    (r.workflows.length > 0 ? r.workflows : [null]).map((w, i) => (
                      <tr key={`${r.repoFullName}-${w?.path ?? i}`} className="border-t border-line-soft">
                        <td className="font-mono-data py-2.5 pr-3 text-[0.78rem]">{i === 0 ? r.repoFullName : ""}</td>
                        <td className="py-2.5 pr-3 text-[0.82rem]">{w ? (w.name ?? w.path) : <span className="text-ink-faint">no workflow parsed</span>}</td>
                        <td className="font-mono-data py-2.5 pr-3 text-[0.7rem] text-ink-soft">
                          {w?.triggers.join(" · ") ?? "—"}
                        </td>
                        <td className="py-2.5 pr-3">
                          <VersionBadge version={w?.actionVersion ?? null} latest={inv.latestVersion} />
                        </td>
                        <td className="font-mono-data py-2.5 pr-2 text-right text-[0.78rem]">{i === 0 ? r.runs30d : ""}</td>
                        <td className="font-mono-data py-2.5 text-right text-[0.72rem] text-ink-faint">
                          {i === 0 ? relativeTime(r.lastRunAt) : ""}
                        </td>
                      </tr>
                    )),
                  )}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}
