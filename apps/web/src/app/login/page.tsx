import { LogoMark } from "@/components/logo";
import { LoginHelp } from "./help";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const params = await searchParams;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-rail">
      <div className="w-full max-w-sm px-6">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <LogoMark size={64} animated />
          <h1 className="font-display text-2xl font-bold tracking-tight text-rail-ink">
            scuttledeck
          </h1>
          <p className="font-mono-data text-[0.65rem] uppercase tracking-[0.22em] text-rail-faint">
            watch floor · authorized crew only
          </p>
        </div>

        <form method="post" action="/api/login" className="rounded-lg border border-line bg-surface p-5 shadow-lg">
          {params.next && <input type="hidden" name="next" value={params.next} />}
          <label className="block">
            <span className="font-mono-data mb-1.5 block text-[0.62rem] uppercase tracking-[0.16em] text-ink-faint">
              dashboard password
            </span>
            <input
              type="password"
              name="password"
              autoFocus
              autoComplete="current-password"
              className="font-mono-data w-full rounded-md border border-line bg-ground px-3 py-2 text-sm text-ink outline-none focus:border-signal"
            />
          </label>
          {params.error && (
            <p className="mt-2 text-[0.78rem]" style={{ color: "var(--sd-crit)" }}>
              ✕ Wrong password — check the deployment secret.
            </p>
          )}
          <button
            type="submit"
            className="mt-4 w-full rounded-md bg-signal px-4 py-2 text-sm font-semibold text-white hover:bg-signal-deep"
          >
            Board
          </button>
        </form>

        <LoginHelp />
      </div>
    </div>
  );
}
