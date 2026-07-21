# Scuttledeck — DESIGN.md

Source of truth for tokens: `apps/web/src/app/globals.css` (runtime CSS vars, light `:root` + `html[data-theme="dark"]`).

## Themes

- **Chart room (light)**: ground `#f3f0e7` (chart paper + faint plotting grid), surface `#fbfaf5`, ink `#16302b`, signal teal `#0a8a6a`.
- **Night watch (dark)**: ground `#0e1c17`, surface `#132622`, ink `#dfe9e2`, signal `#27a37f`.
- Rail is always dark (`--sd-rail`), both themes — the instrument bezel.

## Color roles

- `signal` — the brand teal; primary actions, active states, single-series chart marks.
- Status (icon + label always): good/warn/info/crit, per-theme validated values in globals.css.
- Categorical chart hues (max 4, fixed order): `--sd-cat-1..4`, validated per surface with the dataviz palette validator.
- Chips via `.chip .chip-{good,warn,info,crit,muted,signal}` classes.

## Typography

- Display: Bricolage Grotesque (`--font-display`) — headings, panel titles.
- Body: Instrument Sans (`--font-body`).
- Data: Spline Sans Mono (`--font-mono`, `.font-mono-data`, tabular-nums) — all numerals, table meta, labels.
- Micro-labels: mono, 0.62rem, uppercase, tracking 0.14–0.22em.

## Components

- `Panel` (title + meta + `.rule-sounding` nautical hairline), `StatTile`, `EmptyState` — `apps/web/src/components/panels.tsx`.
- Chips — `chips.tsx`; charts (Sparkbars, RunsBarChart, SpendBars, TokenBars — thin marks, 4px rounded data-ends, 2px gaps, recessive grid) — `charts.tsx`.
- `Rail` — collapsible dark sidebar, theme toggle, cookie-persisted (`sd_theme`, `sd_rail`).
- Logo: deck-scuttle-as-sonar mark (`logo.tsx`, `docs/logo.svg`).

## Layout

- App shell: fixed dark rail (240px / 64px collapsed) + `max-w-6xl` content column, px-10 py-8.
- Money format: 2 decimals ≥ $0.01, 4 below; zero/absent → em-dash with reason (`lib/format.ts`).

## Motion

Minimal and purposeful: `animate-blip` (running-status pulse), rail width transition 200ms. Respect prefers-reduced-motion for anything added.
