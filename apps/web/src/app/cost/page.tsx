import { Panel, StatTile } from "@/components/panels";
import { compactTokens, usd } from "@/lib/format";
import { costKpis, reconciliation, spendBy, type LabeledSpend } from "@/lib/queries-insights";

export const dynamic = "force-dynamic";

function LabeledBars({ rows }: { rows: LabeledSpend[] }) {
  const max = Math.max(0.000001, ...rows.map((r) => r.costUsd));
  return (
    <div className="space-y-2.5">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[9rem_1fr_5.5rem] items-center gap-3">
          <span className="font-mono-data truncate text-[0.75rem] text-ink-soft" title={r.label}>
            {r.label}
          </span>
          <div className="h-3.5">
            <div
              className="h-full rounded-r-[4px] bg-signal"
              style={{ width: `${Math.max(1.5, (r.costUsd / max) * 100)}%`, minWidth: "3px" }}
              title={`${r.label}: ${usd(r.costUsd)} · ${compactTokens(r.tokens)} tokens`}
            />
          </div>
          <span className="font-mono-data text-right text-[0.78rem] text-ink">
            {r.costUsd > 0 ? usd(r.costUsd) : `${compactTokens(r.tokens)} tok`}
          </span>
        </div>
      ))}
    </div>
  );
}

export default async function CostPage() {
  const [kpis, byDay, byModel, byWorkflow, recon] = await Promise.all([
    costKpis(),
    spendBy("day", 30),
    spendBy("model", 30),
    spendBy("workflow", 30),
    reconciliation(14),
  ]);
  const hasBilled = recon.some((r) => r.billedUsd !== null);

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-7">
        <p className="font-mono-data text-[0.65rem] uppercase tracking-[0.22em] text-ink-faint">
          cost · unit economics
        </p>
        <h1 className="font-display mt-1 text-[1.9rem] font-bold tracking-tight">Where the tokens go</h1>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="spend · MTD" value={usd(kpis.mtd)} sub={`prev month ${usd(kpis.prevMonth)}`} />
        <StatTile label="avg cost / run" value={usd(kpis.avgPerRun, 4)} sub="correlated runs" />
        <StatTile label="avg cost / review" value={usd(kpis.avgPerReview, 4)} sub="PR reviews" />
        <StatTile
          label="provenance"
          value="OTel"
          sub="per-run estimates; reconciliation below"
        />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Panel title="Spend by day" meta="30 days">
          {byDay.length === 0 ? <p className="text-sm text-ink-soft">No spend yet.</p> : <LabeledBars rows={byDay} />}
        </Panel>
        <Panel title="Spend by model" meta="30 days">
          {byModel.length === 0 ? <p className="text-sm text-ink-soft">No spend yet.</p> : <LabeledBars rows={byModel} />}
        </Panel>
        <Panel title="Spend by workflow" meta="30 days">
          {byWorkflow.length === 0 ? <p className="text-sm text-ink-soft">No spend yet.</p> : <LabeledBars rows={byWorkflow} />}
        </Panel>
      </div>

      <div className="mt-4">
        <Panel title="Estimate vs invoice" meta="reconciliation · 14 days">
          {!hasBilled ? (
            <p className="text-sm leading-relaxed text-ink-soft">
              No billing data yet. Set <code className="font-mono-data">ANTHROPIC_ADMIN_KEY</code> on the ingest to
              enable the cost-report poller — billing-accurate org totals land here daily and every estimate gets a
              drift percentage. Behind a Bedrock/Vertex gateway there is no Anthropic invoice; reconcile against your
              gateway&apos;s spend logs instead (see docs/gateways.md).
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="font-mono-data text-left text-[0.62rem] uppercase tracking-[0.14em] text-ink-faint">
                  <th className="pb-2 font-normal">day</th>
                  <th className="pb-2 pr-2 text-right font-normal">estimated</th>
                  <th className="pb-2 pr-2 text-right font-normal">billed</th>
                  <th className="pb-2 text-right font-normal">drift</th>
                </tr>
              </thead>
              <tbody>
                {recon.map((r) => (
                  <tr key={r.day} className="border-t border-line-soft">
                    <td className="font-mono-data py-2 pr-3 text-[0.75rem]">{r.day}</td>
                    <td className="font-mono-data py-2 pr-2 text-right text-[0.78rem]">{usd(r.estUsd)}</td>
                    <td className="font-mono-data py-2 pr-2 text-right text-[0.78rem]">{r.billedUsd != null ? usd(r.billedUsd) : "—"}</td>
                    <td className="font-mono-data py-2 text-right text-[0.78rem]">
                      {r.driftPct != null ? `${r.driftPct > 0 ? "+" : ""}${r.driftPct.toFixed(1)}%` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}
