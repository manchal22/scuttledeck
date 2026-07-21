const STATUS: Record<string, { tone: string; icon: string; label: string }> = {
  success: { tone: "chip-good", icon: "✓", label: "success" },
  failure: { tone: "chip-crit", icon: "✕", label: "failure" },
  cancelled: { tone: "chip-muted", icon: "⊘", label: "cancelled" },
  timed_out: { tone: "chip-warn", icon: "◷", label: "timed out" },
  in_progress: { tone: "chip-info", icon: "●", label: "running" },
  queued: { tone: "chip-muted", icon: "○", label: "queued" },
};

/** Run state chip — icon + label always, never color alone. */
export function StatusChip({ status, conclusion }: { status: string; conclusion: string | null }) {
  const key = status === "completed" ? (conclusion ?? "cancelled") : status;
  const s = STATUS[key] ?? STATUS["queued"]!;
  return (
    <span className={`chip ${s.tone}`}>
      <span aria-hidden="true" className={key === "in_progress" ? "animate-blip" : ""}>
        {s.icon}
      </span>
      {s.label}
    </span>
  );
}

/** PR lifecycle chip. */
export function PrStateChip({ state, merged }: { state: string; merged: boolean }) {
  if (merged) return <span className="chip chip-signal">⇥ merged</span>;
  if (state === "closed") return <span className="chip chip-muted">⊘ closed</span>;
  return <span className="chip chip-info">◇ open</span>;
}

/**
 * Cost provenance — every dollar figure is labeled with where it came from.
 */
export function ProvenanceChip({
  source,
  confidence,
  hasCost,
}: {
  source: string | null;
  confidence: string | null;
  hasCost: boolean;
}) {
  if (!source) return null;
  let text: string;
  let tone = "chip-signal";
  if (!hasCost) {
    text = "tokens · included in subscription";
    tone = "chip-muted";
  } else if (source === "otel" && confidence === "exact") {
    text = "otel · exact";
  } else if (source === "otel" && confidence === "heuristic") {
    text = "otel · heuristic match";
    tone = "chip-warn";
  } else if (source === "analytics_api") {
    text = "analytics api · daily";
    tone = "chip-muted";
  } else {
    text = `${source} · ${confidence ?? "unmatched"}`;
    tone = "chip-muted";
  }
  return (
    <span className={`chip ${tone}`} title="Cost provenance" style={{ fontSize: "0.65rem" }}>
      {text}
    </span>
  );
}

/** Action-version badge with fleet drift detection. */
export function VersionBadge({ version, latest }: { version: string | null; latest: string | null }) {
  if (!version) return <span className="text-ink-faint">—</span>;
  const behind = latest !== null && version !== latest && /^v?\d/.test(version);
  return (
    <span
      className={`chip ${behind ? "chip-warn" : "chip-signal"}`}
      style={{ fontSize: "0.68rem", border: "1px solid currentColor", background: "transparent" }}
    >
      {version}
      {behind && <span title={`fleet latest is ${latest}`}>▲ behind</span>}
    </span>
  );
}
