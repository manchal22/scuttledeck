/**
 * One icon vocabulary for the rail: 24-grid, 1.5 stroke, currentColor.
 * Semantics survive collapse — icons identify pages where labels can't.
 */
type IconProps = { size?: number };

function Svg({ size = 18, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Fleet — the scope: ring, sweep, contact blip. */
export function IconFleet(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 12 L17.5 6.5" />
      <circle cx="9" cy="15" r="1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** Runs — activity pulse. */
export function IconRuns(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 12h4l3-7 4 14 3-7h4" />
    </Svg>
  );
}

/** Pull requests — merge glyph. */
export function IconPrs(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="6" cy="5.5" r="2.25" />
      <circle cx="6" cy="18.5" r="2.25" />
      <circle cx="18" cy="18.5" r="2.25" />
      <path d="M6 7.75v8.5" />
      <path d="M10 5.5h3a5 5 0 0 1 5 5v5.75" />
    </Svg>
  );
}

/** Cost — the dollar. */
export function IconCost(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 2.5v19" />
      <path d="M16.5 6H9.75a3 3 0 0 0 0 6h4.5a3 3 0 0 1 0 6H7.5" />
    </Svg>
  );
}

/** Alerts — the klaxon bell. */
export function IconAlerts(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6.5 9a5.5 5.5 0 0 1 11 0c0 5.5 2 7 2 7h-15s2-1.5 2-7" />
      <path d="M10.5 19.5a1.75 1.75 0 0 0 3 0" />
    </Svg>
  );
}

/** Settings — the rigging sliders. */
export function IconSettings(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 7h16M4 12h16M4 17h16" />
      <circle cx="9" cy="7" r="1.9" fill="var(--sd-rail)" />
      <circle cx="15" cy="12" r="1.9" fill="var(--sd-rail)" />
      <circle cx="7" cy="17" r="1.9" fill="var(--sd-rail)" />
    </Svg>
  );
}

export function IconMoon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M20 13.5A8 8 0 0 1 10.5 4 8 8 0 1 0 20 13.5Z" />
    </Svg>
  );
}

export function IconSun(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5 5l1.8 1.8M17.2 17.2 19 19M19 5l-1.8 1.8M6.8 17.2 5 19" />
    </Svg>
  );
}

/** Rail collapse/expand — double chevron, the established affordance. */
export function IconChevrons({ size = 18, direction }: IconProps & { direction: "left" | "right" }) {
  const d = direction === "left" ? "M11 6l-5 6 5 6M18 6l-5 6 5 6" : "M6 6l5 6-5 6M13 6l5 6-5 6";
  return (
    <Svg size={size}>
      <path d={d} />
    </Svg>
  );
}

export function IconSignOut(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M14 4H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7" />
      <path d="M17 8.5 20.5 12 17 15.5M20.5 12H10" />
    </Svg>
  );
}
