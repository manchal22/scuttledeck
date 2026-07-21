"use client";

import { useState } from "react";

/**
 * Copy that works on insecure origins too: navigator.clipboard needs a
 * secure context (https/localhost), so fall back to a transient textarea +
 * execCommand. Failure is shown, never swallowed.
 */
async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to legacy path */
    }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({ text, className = "" }: { text: string; className?: string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");

  const onClick = async () => {
    const ok = await copyText(text);
    setState(ok ? "ok" : "fail");
    setTimeout(() => setState("idle"), 1800);
  };

  return (
    <button
      type="button"
      onClick={onClick}
      title="Copy to clipboard"
      className={`font-mono-data shrink-0 rounded border border-line px-2 py-1 text-[0.65rem] text-ink-soft hover:border-signal hover:text-signal-deep ${className}`}
    >
      {state === "ok" ? "✓ copied" : state === "fail" ? "✕ select manually" : "⧉ copy"}
    </button>
  );
}
