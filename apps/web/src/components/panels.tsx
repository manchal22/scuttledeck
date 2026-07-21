import type { ReactNode } from "react";

export function Panel({
  title,
  meta,
  children,
  className = "",
}: {
  title: string;
  meta?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg border border-line bg-surface shadow-[0_1px_0_rgba(22,48,43,0.04)] ${className}`}>
      <header className="rule-sounding flex items-baseline justify-between px-5 pb-2.5 pt-4">
        <h2 className="font-display text-[0.95rem] font-semibold tracking-tight">{title}</h2>
        {meta && <span className="font-mono-data text-[0.65rem] uppercase tracking-[0.14em] text-ink-faint">{meta}</span>}
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export function StatTile({
  label,
  value,
  sub,
  spark,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  spark?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3.5 shadow-[0_1px_0_rgba(22,48,43,0.04)]">
      <p className="font-mono-data text-[0.62rem] uppercase tracking-[0.18em] text-ink-faint">{label}</p>
      <p className="font-mono-data mt-1.5 text-[1.7rem] leading-none font-medium text-ink">{value}</p>
      <div className="mt-2 flex items-end justify-between gap-2">
        <div className="text-[0.72rem] text-ink-soft">{sub}</div>
        {spark}
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-line bg-surface/60 px-8 py-10 text-center">
      <p className="font-display text-lg font-semibold">{title}</p>
      <div className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-ink-soft">{children}</div>
    </div>
  );
}
