"use client";

import { useState } from "react";

const CMD =
  "kubectl get secret scuttledeck-secrets -n scuttledeck -o jsonpath='{.data.DASHBOARD_PASSWORD}' | base64 -d";

export function LoginHelp() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(CMD);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable (http origin) — text stays selectable */
    }
  };

  return (
    <div className="mt-4 text-center">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="font-mono-data text-[0.68rem] text-rail-faint underline decoration-dotted underline-offset-4 hover:text-signal-bright"
      >
        ? where do I find the password
      </button>
      {open && (
        <div className="mt-3 rounded-md border border-rail-2 bg-rail-2/50 p-3 text-left">
          <p className="font-mono-data mb-2 text-[0.62rem] uppercase tracking-[0.16em] text-rail-faint">
            printed by helm install — or read it from the cluster:
          </p>
          <div className="flex items-start gap-2">
            <code className="font-mono-data flex-1 break-all text-[0.68rem] leading-relaxed text-rail-ink select-all">
              {CMD}
            </code>
            <button
              type="button"
              onClick={copy}
              title="Copy command"
              className="font-mono-data shrink-0 rounded border border-rail-2 px-2 py-1 text-[0.65rem] text-rail-faint hover:border-signal-deep hover:text-signal-bright"
            >
              {copied ? "✓ copied" : "⧉ copy"}
            </button>
          </div>
          <p className="font-mono-data mt-2 text-[0.6rem] leading-relaxed text-rail-faint">
            docker compose users: it&apos;s the DASHBOARD_PASSWORD env on the web service.
          </p>
        </div>
      )}
    </div>
  );
}
