"use client";

import { useState } from "react";

/**
 * Deliberately sparse: this page is pre-auth and public, so it names no
 * namespaces, secret names, or commands. Operators have the helm NOTES and
 * the deploy guide; everyone else gets the password from their operator.
 */
export function LoginHelp() {
  const [open, setOpen] = useState(false);

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
        <p className="font-mono-data mx-auto mt-3 max-w-xs text-[0.68rem] leading-relaxed text-rail-faint">
          It&apos;s generated at deploy time — ask whoever runs this instance.
          Operators: <code>helm install</code> printed it, and the{" "}
          <a
            href="https://github.com/manchal22/scuttledeck/blob/main/docs/deploy-kubernetes.md#after-install"
            className="underline hover:text-signal-bright"
            target="_blank"
            rel="noreferrer"
          >
            deploy guide
          </a>{" "}
          shows how to read it back.
        </p>
      )}
    </div>
  );
}
