"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ComponentType } from "react";
import { Logo, LogoMark } from "@/components/logo";
import {
  IconAlerts,
  IconChevrons,
  IconCost,
  IconFleet,
  IconMoon,
  IconPrs,
  IconRuns,
  IconSettings,
  IconSignOut,
  IconSun,
} from "@/components/icons";

const NAV: Array<{ href: string; label: string; Icon: ComponentType<{ size?: number }> }> = [
  { href: "/", label: "Fleet", Icon: IconFleet },
  { href: "/runs", label: "Runs", Icon: IconRuns },
  { href: "/prs", label: "Pull Requests", Icon: IconPrs },
  { href: "/cost", label: "Cost", Icon: IconCost },
  { href: "/alerts", label: "Alerts", Icon: IconAlerts },
  { href: "/settings", label: "Settings", Icon: IconSettings },
];

function setCookie(name: string, value: string) {
  document.cookie = `${name}=${value}; path=/; max-age=31536000; samesite=lax`;
}

const controlBtn =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-rail-2 text-rail-faint " +
  "hover:border-signal-deep hover:text-signal-bright focus-visible:outline-2 focus-visible:outline-signal-bright";

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
    const apply = () => {
      setTheme(next);
      document.documentElement.dataset.theme = next;
      setCookie("sd_theme", next);
    };
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const doc = document as Document & { startViewTransition?: (cb: () => void) => void };
    if (!reduceMotion && typeof doc.startViewTransition === "function") {
      // crossfade the whole page between themes
      doc.startViewTransition(apply);
    } else if (!reduceMotion) {
      // fallback: briefly transition color-bearing properties
      const el = document.documentElement;
      el.classList.add("theme-transition");
      apply();
      window.setTimeout(() => el.classList.remove("theme-transition"), 400);
    } else {
      apply();
    }
  };

  return (
    <aside
      className={`sticky top-0 flex h-screen shrink-0 flex-col bg-rail text-rail-ink transition-[width] duration-200 motion-reduce:transition-none ${collapsed ? "w-16" : "w-60"}`}
    >
      <div className={`pt-6 pb-7 ${collapsed ? "flex justify-center px-0" : "px-5"}`}>
        <Link
          href="/"
          title="Fleet"
          className="focus-visible:outline-2 focus-visible:outline-signal-bright"
        >
          {collapsed ? <LogoMark size={34} /> : <Logo />}
        </Link>
      </div>

      <nav className={`flex-1 ${collapsed ? "px-2.5" : "px-3"}`} aria-label="Primary">
        {!collapsed && (
          <p className="font-mono-data px-2 pb-2 text-[0.62rem] uppercase tracking-[0.2em] text-rail-faint">
            Bridge
          </p>
        )}
        {NAV.map(({ href, label, Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              title={label}
              aria-current={active ? "page" : undefined}
              className={`relative mb-1 flex items-center rounded-md py-2 focus-visible:outline-2 focus-visible:outline-signal-bright ${
                collapsed ? "justify-center" : "gap-3 px-3"
              } ${active ? "bg-rail-2 text-signal-bright" : "text-rail-ink hover:bg-rail-2"}`}
            >
              {active && (
                <span
                  aria-hidden="true"
                  className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-signal-bright"
                />
              )}
              <span className={active ? "" : "text-rail-faint"}>
                <Icon size={18} />
              </span>
              {!collapsed && (
                <span className={`text-[0.95rem] ${active ? "font-semibold" : "font-medium"}`}>{label}</span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className={`pb-5 ${collapsed ? "px-2.5" : "px-5"}`}>
        <div className={`flex gap-1.5 ${collapsed ? "flex-col" : ""}`}>
          <button
            onClick={toggleTheme}
            title={theme === "dark" ? "Switch to chart room (light)" : "Switch to night watch (dark)"}
            aria-label="Toggle color theme"
            className={`${controlBtn} ${collapsed ? "w-full" : "flex-1 px-2"}`}
          >
            {theme === "dark" ? <IconSun size={16} /> : <IconMoon size={16} />}
            {!collapsed && (
              <span className="font-mono-data text-[0.66rem]">{theme === "dark" ? "day" : "night"}</span>
            )}
          </button>
          <button
            onClick={toggleCollapsed}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            className={`${controlBtn} ${collapsed ? "w-full" : "flex-1 px-2"}`}
          >
            <IconChevrons size={16} direction={collapsed ? "right" : "left"} />
            {!collapsed && <span className="font-mono-data text-[0.66rem]">collapse</span>}
          </button>
        </div>

        {authEnabled && (
          <div className="mt-3 border-t border-rail-2 pt-3">
            <a
              href="/api/logout"
              title="Sign out"
              aria-label="Sign out"
              className={`${controlBtn} ${collapsed ? "w-full" : "px-2.5"}`}
            >
              <IconSignOut size={16} />
              {!collapsed && <span className="font-mono-data text-[0.66rem]">sign out</span>}
            </a>
          </div>
        )}

        {!collapsed && (
          <p className="font-mono-data mt-3 text-[0.62rem] leading-relaxed text-rail-faint">
            v0.1.0 · community project —<br />
            not affiliated with Anthropic
          </p>
        )}
      </div>
    </aside>
  );
}
