"use client";

import { useActionState } from "react";
import { CopyButton } from "@/components/copy-button";
import { rotateToken, type RotateResult } from "./actions";

export function RotateTokenButton({ installationId }: { installationId: number }) {
  const [state, formAction, pending] = useActionState<RotateResult, FormData>(rotateToken, {});

  return (
    <div>
      <form action={formAction}>
        <input type="hidden" name="id" value={installationId} />
        <button
          disabled={pending}
          className="font-mono-data rounded-md border border-line px-2.5 py-1 text-[0.7rem] text-ink-soft hover:border-signal hover:text-signal-deep disabled:opacity-50"
        >
          {pending ? "rotating…" : "⟳ rotate token"}
        </button>
      </form>
      {state.token && (
        <div className="mt-2 rounded-md border border-line bg-surface-2 p-2.5">
          <p className="font-mono-data text-[0.62rem] uppercase tracking-[0.16em] text-ink-faint">
            new token — shown once, copy it now
          </p>
          <div className="flex items-start gap-2">
            <code className="font-mono-data flex-1 break-all text-[0.75rem] select-all">{state.token}</code>
            <CopyButton text={state.token} />
          </div>
          <p className="mt-1.5 text-[0.7rem] leading-relaxed text-ink-soft">
            Update the <code>SCUTTLEDECK_TOKEN</code> Actions secret, and — if the deployment sets{" "}
            <code>INGEST_TOKEN</code> via env/Helm — the deployment secret too, or the old value re-registers on the
            next restart.
          </p>
        </div>
      )}
      {state.error && (
        <p className="mt-1 text-[0.72rem]" style={{ color: "var(--sd-crit)" }}>
          {state.error}
        </p>
      )}
    </div>
  );
}
