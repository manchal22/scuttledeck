"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

/** Filters apply on change — no Apply button; the query is a fast local read. */
export function RunsFilters({
  repos,
  events,
}: {
  repos: string[];
  events: string[];
}) {
  const router = useRouter();
  const params = useSearchParams();

  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("page"); // filter changes reset pagination
    router.push(`/runs${next.size ? `?${next.toString()}` : ""}`);
  };

  const select =
    "rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink";
  const label =
    "font-mono-data mb-1 block text-[0.62rem] uppercase tracking-[0.16em] text-ink-faint";
  const hasFilters = ["status", "repo", "event", "since"].some((k) => params.get(k));

  return (
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <label className="block">
        <span className={label}>status</span>
        <select className={select} value={params.get("status") ?? ""} onChange={(e) => update("status", e.target.value)}>
          <option value="">all</option>
          {["success", "failure", "in_progress", "queued"].map((s) => (
            <option key={s} value={s}>{s.replace("_", " ")}</option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className={label}>repo</span>
        <select className={`${select} max-w-56`} value={params.get("repo") ?? ""} onChange={(e) => update("repo", e.target.value)}>
          <option value="">all</option>
          {repos.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className={label}>trigger</span>
        <select className={select} value={params.get("event") ?? ""} onChange={(e) => update("event", e.target.value)}>
          <option value="">all</option>
          {events.map((e) => (
            <option key={e} value={e}>{e}</option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className={label}>window</span>
        <select className={select} value={params.get("since") ?? ""} onChange={(e) => update("since", e.target.value)}>
          <option value="">all time</option>
          <option value="24h">last 24h</option>
          <option value="7d">last 7 days</option>
          <option value="30d">last 30 days</option>
        </select>
      </label>
      {hasFilters && (
        <Link href="/runs" className="py-1.5 text-sm text-ink-soft underline">
          clear
        </Link>
      )}
    </div>
  );
}
