import { Panel } from "@/components/panels";
import { relativeTime } from "@/lib/format";
import { installations } from "@/lib/queries-insights";
import { RotateTokenButton } from "./rotate";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const insts = await installations();
  const sessionTtlHours = Number(process.env.SESSION_TTL_HOURS ?? 168);

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-7">
        <p className="font-mono-data text-[0.65rem] uppercase tracking-[0.22em] text-ink-faint">
          settings · ship&apos;s papers
        </p>
        <h1 className="font-display mt-1 text-[1.9rem] font-bold tracking-tight">Rigging</h1>
      </header>

      <Panel title="Installations" meta="ingest credentials">
        <table className="w-full text-sm">
          <thead>
            <tr className="font-mono-data text-left text-[0.62rem] uppercase tracking-[0.14em] text-ink-faint">
              <th className="pb-2 font-normal">org</th>
              <th className="pb-2 font-normal">repos</th>
              <th className="pb-2 font-normal">ingest token</th>
              <th className="pb-2 font-normal">since</th>
              <th className="pb-2 text-right font-normal"></th>
            </tr>
          </thead>
          <tbody>
            {insts.map((i) => (
              <tr key={i.id} className="border-t border-line-soft align-top">
                <td className="font-mono-data py-3 pr-3 text-[0.82rem] font-medium">{i.org}</td>
                <td className="font-mono-data py-3 pr-3 text-[0.78rem]">{i.repos}</td>
                <td className="py-3 pr-3">
                  <span className={`chip ${i.hasToken ? "chip-signal" : "chip-warn"}`}>
                    {i.hasToken ? "● registered (hash only)" : "○ none"}
                  </span>
                </td>
                <td className="font-mono-data py-3 pr-3 text-[0.72rem] text-ink-faint">
                  {relativeTime(new Date(i.createdAt))}
                </td>
                <td className="py-3 text-right">
                  <RotateTokenButton installationId={i.id} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <div className="mt-4">
        <Panel title="Session & retention" meta="deployment env">
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="font-mono-data text-[0.62rem] uppercase tracking-[0.16em] text-ink-faint">
                dashboard session TTL
              </dt>
              <dd className="font-mono-data mt-1 text-[0.9rem]">
                {sessionTtlHours}h
                <span className="ml-2 text-[0.7rem] text-ink-faint">SESSION_TTL_HOURS</span>
              </dd>
            </div>
            <div>
              <dt className="font-mono-data text-[0.62rem] uppercase tracking-[0.16em] text-ink-faint">
                raw webhook retention
              </dt>
              <dd className="font-mono-data mt-1 text-[0.9rem]">
                {process.env.RETENTION_DAYS ?? "30"}d
                <span className="ml-2 text-[0.7rem] text-ink-faint">RETENTION_DAYS (ingest)</span>
              </dd>
            </div>
            <div>
              <dt className="font-mono-data text-[0.62rem] uppercase tracking-[0.16em] text-ink-faint">
                discovery scanner
              </dt>
              <dd className="mt-1 text-[0.85rem] text-ink-soft">
                enabled when <code className="font-mono-data">GITHUB_TOKEN</code> is set on the ingest; rescans hourly
                and on workflow-file pushes
              </dd>
            </div>
            <div>
              <dt className="font-mono-data text-[0.62rem] uppercase tracking-[0.16em] text-ink-faint">
                anthropic admin pollers
              </dt>
              <dd className="mt-1 text-[0.85rem] text-ink-soft">
                enabled when <code className="font-mono-data">ANTHROPIC_ADMIN_KEY</code> is set; Analytics hourly,
                cost report daily
              </dd>
            </div>
          </dl>
        </Panel>
      </div>
    </div>
  );
}
