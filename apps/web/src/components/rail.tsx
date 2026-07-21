"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Logo, LogoMark } from "@/components/logo";

const NAV = [
  { href: "/", label: "Fleet", code: "01" },
  { href: "/runs", label: "Runs", code: "02" },
  { href: "/prs", label: "Pull Requests", code: "03" },
  { href: "/cost", label: "Cost", code: "04" },
  { href: "/alerts", label: "Alerts", code: "05" },
  { href: "/settings", label: "Settings", code: "06" },
] as const;

function setCookie(name: string, value: string) {
  document.cookie = `${name}=${value}; path=/; max-age=31536000; samesite=lax`;
}

export function Rail({
  initialCollapsed,
  initialTheme,
  authEnabled,
}: {
  initialCollapsed: boolean;
  initialTheme: "light" | "dark";
  authEnabled: boolean;
}) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [theme, setTheme] = useState(initialTheme);
  const pathname = usePathname();

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    setCookie("sd_rail", next ? "collapsed" : "open");
  };

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    setCookie("sd_theme", next);
  };

  return (
    <aside
      className={`sticky top-0 flex h-screen shrink-0 flex-col bg-rail text-rail-ink transition-[width] duration-200 ${collapsed ? "w-16" : "w-60"}`}
    >
      <div className={`pt-6 pb-8 ${collapsed ? "px-3 text-center" : "px-5"}`}>
        <Link href="/" className="block" title="Fleet">
          {collapsed ? <LogoMark size={36} /> : <Logo />}
        </Link>
      </div>

      <nav className="flex-1 px-3">
        {!collapsed && (
          <p className="font-mono-data px-2 pb-2 text-[0.62rem] uppercase tracking-[0.2em] text-rail-faint">
            Bridge
          </p>
        )}
        {NAV.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              title={item.label}
              className={`group mb-1 flex items-baseline gap-3 rounded-md px-3 py-2 text-[0.95rem] hover:bg-rail-2 ${active ? "bg-rail-2" : ""} ${collapsed ? "justify-center" : ""}`}
            >
              <span className={`font-mono-data text-[0.65rem] ${active ? "text-signal-bright" : "text-signal-bright/70"}`}>
                {item.code}
              </span>
              {!collapsed && <span className={active ? "font-semibold" : "font-medium"}>{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      <div className={`pb-5 ${collapsed ? "px-2" : "px-5"}`}>
        {/* view controls — grouped and overflow-safe */}
        <div className={`flex gap-1.5 ${collapsed ? "flex-col items-center" : ""}`}>
          <button
            onClick={toggleTheme}
            title={theme === "dark" ? "Switch to chart room (light)" : "Switch to night watch (dark)"}
            className="font-mono-data inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-rail-2 px-2 py-1 text-[0.66rem] text-rail-faint hover:border-signal-deep hover:text-signal-bright"
          >
            {theme === "dark" ? "☀" : "☾"}
            {!collapsed && <span>{theme === "dark" ? "day" : "night"}</span>}
          </button>
          <button
            onClick={toggleCollapsed}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="font-mono-data inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-rail-2 px-2 py-1 text-[0.66rem] text-rail-faint hover:border-signal-deep hover:text-signal-bright"
          >
            {collapsed ? "⟩" : "⟨"}
            {!collapsed && <span>collapse</span>}
          </button>
        </div>
        {/* sign-out lives apart from the view controls so it can't be fat-fingered */}
        {authEnabled && (
          <div className={`mt-3 border-t border-rail-2 pt-3 ${collapsed ? "text-center" : ""}`}>
            <a
              href="/api/logout"
              title="Sign out"
              className="font-mono-data inline-flex items-center gap-1 whitespace-nowrap text-[0.66rem] text-rail-faint underline decoration-dotted underline-offset-4 hover:text-signal-bright"
            >
              ⎋{!collapsed && <span>sign out</span>}
            </a>
          </div>
        )}
        {!collapsed && (
          <p className="font-mono-data mt-3 text-[0.62rem] leading-relaxed text-rail-faint">
            v0.1.0-rc · community project —<br />
            not affiliated with Anthropic
          </p>
        )}
      </div>
    </aside>
  );
}
