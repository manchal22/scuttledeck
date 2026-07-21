import type { DayBucket, RepoSpend } from "@/lib/queries";
import { compactTokens, usd } from "@/lib/format";

/**
 * Mark specs (dataviz): thin marks, rounded data-ends anchored to the
 * baseline, 2px gaps between fills, recessive grid, text in ink tokens.
 */

/** Tiny bar sparkline for stat tiles — single series, no legend needed. */
export function Sparkbars({
  buckets,
  width = 120,
  height = 28,
}: {
  buckets: DayBucket[];
  width?: number;
  height?: number;
}) {
  const max = Math.max(1, ...buckets.map((b) => b.runs));
  const gap = 2;
  const barW = Math.max(2, (width - gap * (buckets.length - 1)) / buckets.length);
  return (
    <svg width={width} height={height} role="img" aria-label="daily run counts">
      {buckets.map((b, i) => {
        const h = Math.max(1.5, (b.runs / max) * (height - 2));
        return (
          <rect
            key={b.day}
            x={i * (barW + gap)}
            y={height - h}
            width={barW}
            height={h}
            rx={1.5}
            fill={b.runs === 0 ? "var(--sd-bar-empty)" : "var(--sd-signal)"}
          >
            <title>{`${b.day}: ${b.runs} runs${b.failures ? `, ${b.failures} failed` : ""}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

/** 14-day run volume, with failures as a darker segment (2px surface gap). */
export function RunsBarChart({ buckets }: { buckets: DayBucket[] }) {
  const width = 660;
  const height = 120;
  const labelH = 18;
  const max = Math.max(1, ...buckets.map((b) => b.runs));
  const gap = 6;
  const barW = (width - gap * (buckets.length - 1)) / buckets.length;

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${width} ${height + labelH}`}
      role="img"
      aria-label="runs per day, last 14 days"
    >
      {/* recessive gridlines at 50% and 100% */}
      {[0.5, 1].map((t) => (
        <line
          key={t}
          x1={0}
          x2={width}
          y1={height - t * (height - 14)}
          y2={height - t * (height - 14)}
          stroke="var(--sd-grid)"
          strokeDasharray="2 4"
        />
      ))}
      {buckets.map((b, i) => {
        const x = i * (barW + gap);
        const okRuns = b.runs - b.failures;
        const hOk = (okRuns / max) * (height - 14);
        const hFail = (b.failures / max) * (height - 14);
        const day = b.day.slice(5).replace("-", "/");
        return (
          <g key={b.day}>
            {b.runs === 0 && (
              <rect x={x} y={height - 1.5} width={barW} height={1.5} fill="var(--sd-bar-empty)" />
            )}
            {hOk > 0 && (
              <rect x={x} y={height - hOk} width={barW} height={hOk} rx={3} fill="var(--sd-signal)">
                <title>{`${b.day}: ${okRuns} succeeded`}</title>
              </rect>
            )}
            {hFail > 0 && (
              // failure segment sits above with a 2px surface gap
              <rect x={x} y={height - hOk - hFail - 2} width={barW} height={hFail} rx={3} fill="var(--sd-crit)">
                <title>{`${b.day}: ${b.failures} failed`}</title>
              </rect>
            )}
            {/* selective direct labels: peak day only */}
            {b.runs === max && (
              <text
                x={x + barW / 2}
                y={height - hOk - hFail - 7}
                textAnchor="middle"
                className="font-mono-data"
                fontSize="10"
                fill="var(--sd-ink-soft)"
              >
                {b.runs}
              </text>
            )}
            {i % 2 === 0 && (
              <text
                x={x + barW / 2}
                y={height + 13}
                textAnchor="middle"
                fontSize="9.5"
                className="font-mono-data"
                fill="var(--sd-ink-faint)"
              >
                {day}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** Spend leaderboard — horizontal bars, direct labels, single hue. */
export function SpendBars({ rows }: { rows: RepoSpend[] }) {
  const max = Math.max(0.000001, ...rows.map((r) => r.costUsd));
  return (
    <div className="space-y-2.5">
      {rows.map((r) => {
        const pct = Math.max(1.5, (r.costUsd / max) * 100);
        const name = r.repoFullName.split("/")[1] ?? r.repoFullName;
        return (
          <div key={r.repoFullName} className="grid grid-cols-[minmax(9rem,14rem)_1fr_5.5rem] items-center gap-3">
            <span className="font-mono-data truncate text-[0.75rem] text-ink-soft" title={r.repoFullName}>
              {name}
            </span>
            <div className="h-3.5">
              <div
                className="h-full rounded-r-[4px] bg-signal"
                style={{ width: `${pct}%`, minWidth: "3px" }}
                title={`${r.repoFullName}: ${usd(r.costUsd)} · ${compactTokens(r.tokens)} tokens · ${r.sessions} sessions`}
              />
            </div>
            <span className="font-mono-data text-right text-[0.78rem] text-ink">
              {r.costUsd > 0 ? usd(r.costUsd) : `${compactTokens(r.tokens)} tok`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Token breakdown for a session — horizontal bars with direct labels. */
export function TokenBars({
  rows,
}: {
  rows: Array<{ label: string; value: number }>;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[7.5rem_1fr_4.5rem] items-center gap-3">
          <span className="font-mono-data text-[0.72rem] text-ink-soft">{r.label}</span>
          <div className="h-3">
            <div
              className="h-full rounded-r-[4px] bg-signal/80"
              style={{ width: `${Math.max(1, (r.value / max) * 100)}%`, minWidth: r.value > 0 ? "3px" : "0" }}
            />
          </div>
          <span className="font-mono-data text-right text-[0.75rem] text-ink">
            {compactTokens(r.value)}
          </span>
        </div>
      ))}
    </div>
  );
}
