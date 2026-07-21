const STATUS_STYLES: Record<string, { fg: string; bg: string; icon: string; label: string }> = {
  success: { fg: "#178a4c", bg: "rgba(23,138,76,0.1)", icon: "✓", label: "success" },
  failure: { fg: "#c62f27", bg: "rgba(198,47,39,0.09)", icon: "✕", label: "failure" },
  cancelled: { fg: "#51625b", bg: "rgba(81,98,91,0.1)", icon: "⊘", label: "cancelled" },
  timed_out: { fg: "#b8860b", bg: "rgba(184,134,11,0.12)", icon: "◷", label: "timed out" },
  in_progress: { fg: "#0b6bcb", bg: "rgba(11,107,203,0.09)", icon: "●", label: "running" },
  queued: { fg: "#51625b", bg: "rgba(81,98,91,0.1)", icon: "○", label: "queued" },
};

/** Run state chip — icon + label always, never color alone. */
export function StatusChip({ status, conclusion }: { status: string; conclusion: string | null }) {
  const key = status === "completed" ? (conclusion ?? "cancelled") : status;
  const s = STATUS_STYLES[key] ?? STATUS_STYLES["queued"]!;
  return (
    <span
      className="font-mono-data inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[0.7rem] font-medium"
      style={{ color: s.fg, backgroundColor: s.bg }}
    >
      <span aria-hidden="true" className={key === "in_progress" ? "animate-blip" : ""}>
        {s.icon}
      </span>
      {s.label}
    </span>
  );
}

/**
 * Cost provenance — every dollar figure is labeled with where it came from.
 * exact/heuristic = OTel per-run; subscription installs have tokens, no cost.
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
  let tone: "signal" | "warn" | "muted" = "signal";
  if (!hasCost) {
    text = "tokens · included in subscription";
    tone = "muted";
  } else if (source === "otel" && confidence === "exact") {
    text = "otel · exact";
  } else if (source === "otel" && confidence === "heuristic") {
    text = "otel · heuristic match";
    tone = "warn";
  } else if (source === "analytics_api") {
    text = "analytics api · daily";
    tone = "muted";
  } else {
    text = `${source} · ${confidence ?? "unmatched"}`;
    tone = "muted";
  }
  const styles = {
    signal: { color: "#0b6b54", backgroundColor: "rgba(10,138,106,0.09)" },
    warn: { color: "#8a6508", backgroundColor: "rgba(184,134,11,0.12)" },
    muted: { color: "#51625b", backgroundColor: "rgba(81,98,91,0.08)" },
  }[tone];
  return (
    <span
      className="font-mono-data inline-flex items-center rounded-full px-2 py-0.5 text-[0.65rem]"
      style={styles}
      title="Cost provenance"
    >
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
      className="font-mono-data inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[0.68rem]"
      style={
        behind
          ? { color: "#8a6508", borderColor: "rgba(184,134,11,0.45)", backgroundColor: "rgba(184,134,11,0.08)" }
          : { color: "#0b6b54", borderColor: "rgba(10,138,106,0.35)" }
      }
    >
      {version}
      {behind && <span title={`fleet latest is ${latest}`}>▲ behind</span>}
    </span>
  );
}
