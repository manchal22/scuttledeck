import { PrStateChip } from "@/components/chips";
import { EmptyState, Panel, StatTile } from "@/components/panels";
import { relativeTime, usd } from "@/lib/format";
import { prKpis, reviewedPrs, topAuthors } from "@/lib/queries-insights";

export const dynamic = "force-dynamic";

export default async function PrsPage() {
  const [kpis, prs, authors] = await Promise.all([prKpis(), reviewedPrs(), topAuthors()]);
  const mergeRate = kpis.closedReviewed > 0 ? kpis.mergedReviewed / kpis.closedReviewed : null;
  const costPerMerged = kpis.mergedReviewed > 0 ? kpis.totalReviewCost / kpis.mergedReviewed : null;

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-7">
        <p className="font-mono-data text-[0.65rem] uppercase tracking-[0.22em] text-ink-faint">
          pull requests · outcomes
        </p>
        <h1 className="font-display mt-1 text-[1.9rem] font-bold tracking-tight">What the reviews bought</h1>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="PRs reviewed" value={kpis.reviewedPrs.toLocaleString()} sub={`${kpis.reviews} reviews total`} />
        <StatTile
          label="merge rate · reviewed"
          value={mergeRate === null ? "—" : `${Math.round(mergeRate * 100)}%`}
          sub={`${kpis.mergedReviewed} of ${kpis.closedReviewed} closed`}
        />
        <StatTile label="review spend" value={usd(kpis.totalReviewCost)} sub="all time" />
        <StatTile
          label="cost / review"
          value={kpis.reviews > 0 ? usd(kpis.totalReviewCost / kpis.reviews) : "—"}
          sub="mean"
        />
        <StatTile label="cost / merged PR" value={costPerMerged === null ? "—" : usd(costPerMerged)} sub="the unit economic" />
      </div>

      {prs.length === 0 ? (
        <div className="mt-8">
          <EmptyState title="No reviewed PRs yet">
            <p>
              This view fills in once Claude reviews land on PRs <em>and</em> the org webhook subscribes to the{" "}
              <strong>Pull requests</strong> event (for authors and merge outcomes).
            </p>
          </EmptyState>
        </div>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Panel title="Reviewed pull requests" meta={`latest ${prs.length}`} className="xl:col-span-2">
              <table className="w-full text-sm">
                <thead>
                  <tr className="font-mono-data text-left text-[0.62rem] uppercase tracking-[0.14em] text-ink-faint">
                    <th className="pb-2 font-normal">PR</th>
                    <th className="pb-2 font-normal">author</th>
                    <th className="pb-2 font-normal">state</th>
                    <th className="pb-2 pr-2 text-right font-normal">reviews</th>
                    <th className="pb-2 pr-2 text-right font-normal">cost</th>
                    <th className="pb-2 text-right font-normal">last review</th>
                  </tr>
                </thead>
                <tbody>
                  {prs.map((p) => (
                    <tr key={`${p.repoFullName}#${p.prNumber}`} className="border-t border-line-soft hover:bg-signal-wash">
                      <td className="py-2.5 pr-3">
                        <span className="font-mono-data text-[0.7rem] text-ink-faint">{p.repoFullName}</span>
                        <br />
                        <span className="font-medium">#{p.prNumber}{p.title ? ` · ${p.title}` : ""}</span>
                      </td>
                      <td className="font-mono-data py-2.5 pr-3 text-[0.75rem] text-ink-soft">{p.author ?? "—"}</td>
                      <td className="py-2.5 pr-3"><PrStateChip state={p.state} merged={p.merged} /></td>
                      <td className="font-mono-data py-2.5 pr-2 text-right text-[0.78rem]">{p.reviews}</td>
                      <td className="font-mono-data py-2.5 pr-2 text-right text-[0.78rem]">{p.costUsd != null ? usd(p.costUsd) : "—"}</td>
                      <td className="font-mono-data py-2.5 text-right text-[0.72rem] text-ink-faint">{relativeTime(p.lastReviewAt ? new Date(p.lastReviewAt) : null)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>

            <Panel title="Review spend by author" meta="team insight">
              {authors.length === 0 ? (
                <p className="text-sm text-ink-soft">Author attribution needs the Pull requests webhook event.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="font-mono-data text-left text-[0.62rem] uppercase tracking-[0.14em] text-ink-faint">
                      <th className="pb-2 font-normal">author</th>
                      <th className="pb-2 pr-2 text-right font-normal">PRs</th>
                      <th className="pb-2 pr-2 text-right font-normal">merged</th>
                      <th className="pb-2 text-right font-normal">cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {authors.map((a) => (
                      <tr key={a.author} className="border-t border-line-soft">
                        <td className="font-mono-data py-2 pr-3 text-[0.78rem]">{a.author}</td>
                        <td className="font-mono-data py-2 pr-2 text-right text-[0.78rem]">{a.prs}</td>
                        <td className="font-mono-data py-2 pr-2 text-right text-[0.78rem]">{a.merged}</td>
                        <td className="font-mono-data py-2 text-right text-[0.78rem]">{usd(a.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}
