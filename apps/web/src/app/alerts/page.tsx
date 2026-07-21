import { EmptyState, Panel } from "@/components/panels";
import { relativeTime } from "@/lib/format";
import { alertEvents, alertRules } from "@/lib/queries-insights";
import { createRule, deleteRule, toggleRule } from "./actions";

export const dynamic = "force-dynamic";

const KIND_LABELS: Record<string, string> = {
  budget: "Monthly budget",
  cost_anomaly: "Cost anomaly",
  failure_rate: "Failure-rate spike",
  action_stale: "Stale action version",
};

function configSummary(kind: string, config: Record<string, unknown>): string {
  switch (kind) {
    case "budget":
      return `$${config["monthly_usd"]}/mo · warn at ${Number(config["warn_fraction"] ?? 0.8) * 100}%`;
    case "cost_anomaly":
      return `>${config["multiplier"]}× trailing ${config["trailing_days"]}d median`;
    case "failure_rate":
      return `≥${Number(config["threshold"] ?? 0.3) * 100}% failures / ${config["window_hours"]}h (min ${config["min_runs"]} runs)`;
    case "action_stale":
      return `behind fleet latest >${config["days"]}d`;
    default:
      return JSON.stringify(config);
  }
}

export default async function AlertsPage() {
  const [rules, events] = await Promise.all([alertRules(), alertEvents()]);

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-7">
        <p className="font-mono-data text-[0.65rem] uppercase tracking-[0.22em] text-ink-faint">
          alerts · standing orders
        </p>
        <h1 className="font-display mt-1 text-[1.9rem] font-bold tracking-tight">Sound the klaxon</h1>
      </header>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Panel title="Rules" meta={`${rules.filter((r) => r.enabled).length} armed`} className="xl:col-span-2">
          {rules.length === 0 ? (
            <p className="text-sm text-ink-soft">No rules yet — create one on the right. Rules are evaluated every 15 minutes.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="font-mono-data text-left text-[0.62rem] uppercase tracking-[0.14em] text-ink-faint">
                  <th className="pb-2 font-normal">rule</th>
                  <th className="pb-2 font-normal">threshold</th>
                  <th className="pb-2 pr-2 text-right font-normal">fired</th>
                  <th className="pb-2 text-right font-normal">last</th>
                  <th className="pb-2 text-right font-normal"></th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id} className="border-t border-line-soft">
                    <td className="py-2.5 pr-3">
                      <span className={`chip ${r.enabled ? "chip-signal" : "chip-muted"}`}>
                        {r.enabled ? "● armed" : "○ off"}
                      </span>{" "}
                      <span className="font-medium">{KIND_LABELS[r.kind] ?? r.kind}</span>
                    </td>
                    <td className="font-mono-data py-2.5 pr-3 text-[0.72rem] text-ink-soft">
                      {configSummary(r.kind, r.config)}
                    </td>
                    <td className="font-mono-data py-2.5 pr-2 text-right text-[0.78rem]">{r.events}</td>
                    <td className="font-mono-data py-2.5 text-right text-[0.72rem] text-ink-faint">
                      {relativeTime(r.lastFiredAt ? new Date(r.lastFiredAt) : null)}
                    </td>
                    <td className="py-2.5 text-right">
                      <form action={toggleRule} className="inline">
                        <input type="hidden" name="id" value={r.id} />
                        <button className="font-mono-data mr-2 text-[0.68rem] text-ink-soft underline hover:text-signal-deep">
                          {r.enabled ? "disarm" : "arm"}
                        </button>
                      </form>
                      <form action={deleteRule} className="inline">
                        <input type="hidden" name="id" value={r.id} />
                        <button className="font-mono-data text-[0.68rem] underline" style={{ color: "var(--sd-crit)" }}>
                          delete
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="New rule" meta="15-min evaluation">
          <form action={createRule} className="space-y-3">
            <label className="block">
              <span className="font-mono-data mb-1 block text-[0.62rem] uppercase tracking-[0.16em] text-ink-faint">kind</span>
              <select name="kind" className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm">
                <option value="budget">Monthly budget (USD)</option>
                <option value="cost_anomaly">Cost anomaly (× median)</option>
                <option value="failure_rate">Failure-rate spike</option>
                <option value="action_stale">Stale action version</option>
              </select>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="font-mono-data mb-1 block text-[0.62rem] uppercase tracking-[0.16em] text-ink-faint">monthly_usd</span>
                <input name="monthly_usd" type="number" step="any" placeholder="500" className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm" />
              </label>
              <label className="block">
                <span className="font-mono-data mb-1 block text-[0.62rem] uppercase tracking-[0.16em] text-ink-faint">multiplier</span>
                <input name="multiplier" type="number" step="any" placeholder="3" className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm" />
              </label>
              <label className="block">
                <span className="font-mono-data mb-1 block text-[0.62rem] uppercase tracking-[0.16em] text-ink-faint">threshold</span>
                <input name="threshold" type="number" step="any" placeholder="0.3" className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm" />
              </label>
              <label className="block">
                <span className="font-mono-data mb-1 block text-[0.62rem] uppercase tracking-[0.16em] text-ink-faint">days</span>
                <input name="days" type="number" placeholder="14" className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm" />
              </label>
            </div>
            <p className="text-[0.7rem] leading-relaxed text-ink-faint">
              Only the fields matching the kind apply; blanks use sensible defaults.
            </p>
            <label className="block">
              <span className="font-mono-data mb-1 block text-[0.62rem] uppercase tracking-[0.16em] text-ink-faint">
                slack webhook (optional, overrides global)
              </span>
              <input name="slack_webhook_url" type="url" placeholder="https://hooks.slack.com/…" className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm" />
            </label>
            <button className="w-full rounded-md bg-signal px-4 py-2 text-sm font-semibold text-white hover:bg-signal-deep">
              Arm rule
            </button>
          </form>
        </Panel>
      </div>

      <div className="mt-4">
        <Panel title="Fired events" meta={`latest ${events.length}`}>
          {events.length === 0 ? (
            <EmptyState title="All quiet on deck">
              <p>No alert has fired. Events appear here and go to Slack when a webhook is configured.</p>
            </EmptyState>
          ) : (
            <ul className="space-y-2">
              {events.map((e) => (
                <li key={e.id} className="flex items-baseline justify-between gap-4 border-t border-line-soft pt-2 first:border-t-0 first:pt-0">
                  <span className="text-sm">{e.summary}</span>
                  <span className="font-mono-data shrink-0 text-[0.7rem] text-ink-faint">
                    {relativeTime(new Date(e.firedAt))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
