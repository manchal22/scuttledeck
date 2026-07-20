import type { Metadata } from "next";
import { Bricolage_Grotesque, Instrument_Sans, Spline_Sans_Mono } from "next/font/google";
import Link from "next/link";
import { Logo } from "@/components/logo";
import "./globals.css";

const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-bricolage",
});
const instrument = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument",
});
const splineMono = Spline_Sans_Mono({
  subsets: ["latin"],
  variable: "--font-spline-mono",
});

export const metadata: Metadata = {
  title: "Scuttledeck",
  description: "Fleet monitoring for the Claude Code GitHub Action",
};

const NAV = [
  { href: "/", label: "Fleet", code: "01" },
  { href: "/runs", label: "Runs", code: "02" },
] as const;

const LATER = [
  { label: "Pull Requests", phase: "P2" },
  { label: "Cost", phase: "P2" },
  { label: "Alerts", phase: "P3" },
] as const;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${bricolage.variable} ${instrument.variable} ${splineMono.variable}`}>
      <body className="min-h-screen">
        <div className="flex min-h-screen">
          {/* instrument rail */}
          <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col bg-rail text-rail-ink">
            <div className="px-5 pt-6 pb-8">
              <Link href="/" className="block">
                <Logo />
              </Link>
            </div>
            <nav className="flex-1 px-3">
              <p className="font-mono-data px-2 pb-2 text-[0.62rem] uppercase tracking-[0.2em] text-rail-faint">
                Bridge
              </p>
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="group mb-1 flex items-baseline gap-3 rounded-md px-3 py-2 text-[0.95rem] hover:bg-rail-2"
                >
                  <span className="font-mono-data text-[0.65rem] text-signal-bright/70">{item.code}</span>
                  <span className="font-medium">{item.label}</span>
                </Link>
              ))}
              <p className="font-mono-data px-2 pt-6 pb-2 text-[0.62rem] uppercase tracking-[0.2em] text-rail-faint">
                Charted · not yet built
              </p>
              {LATER.map((item) => (
                <div
                  key={item.label}
                  className="mb-1 flex items-baseline justify-between px-3 py-2 text-[0.9rem] text-rail-faint"
                >
                  <span>{item.label}</span>
                  <span className="font-mono-data text-[0.62rem] uppercase">{item.phase}</span>
                </div>
              ))}
            </nav>
            <div className="px-5 pb-5">
              <p className="font-mono-data text-[0.62rem] leading-relaxed text-rail-faint">
                v0.0.1 · p0 spike
                <br />
                community project — not affiliated with Anthropic
              </p>
            </div>
          </aside>

          <main className="min-w-0 flex-1 px-10 py-8">{children}</main>
        </div>
      </body>
    </html>
  );
}
