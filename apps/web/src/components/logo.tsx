/**
 * The Scuttledeck mark: a deck scuttle (hatch) as a sonar screen —
 * steel rim with bolts, radar rings, a sweep, and contact blips.
 */
export function LogoMark({ size = 36, sweep = true }: { size?: number; sweep?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      role="img"
    >
      <defs>
        <linearGradient id="sd-sweep" x1="53.6" y1="19.5" x2="28" y2="14" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2fd4a4" stopOpacity="0.75" />
          <stop offset="1" stopColor="#2fd4a4" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* hatch + steel rim */}
      <circle cx="32" cy="32" r="29.5" fill="#0c1f19" stroke="#3d564d" strokeWidth="1.5" />
      {/* rim bolts */}
      <g fill="#57736a">
        <circle cx="55.6" cy="41.8" r="1.5" />
        <circle cx="41.8" cy="55.6" r="1.5" />
        <circle cx="22.2" cy="55.6" r="1.5" />
        <circle cx="8.4" cy="41.8" r="1.5" />
        <circle cx="8.4" cy="22.2" r="1.5" />
        <circle cx="22.2" cy="8.4" r="1.5" />
        <circle cx="41.8" cy="8.4" r="1.5" />
        <circle cx="55.6" cy="22.2" r="1.5" />
      </g>
      {/* radar rings + crosshair */}
      <g stroke="#1f4a3d" strokeWidth="1">
        <circle cx="32" cy="32" r="18" />
        <circle cx="32" cy="32" r="9" />
        <path d="M32 7v50M7 32h50" strokeWidth="0.75" opacity="0.7" />
      </g>
      {/* sweep wedge + leading edge */}
      {sweep && (
        <>
          <path d="M32 32 L32 7 A25 25 0 0 1 53.65 19.5 Z" fill="url(#sd-sweep)" />
          <path d="M32 32 L53.65 19.5" stroke="#2fd4a4" strokeWidth="2" strokeLinecap="round" />
        </>
      )}
      {/* contact blips */}
      <circle cx="46.5" cy="24.5" r="2.6" fill="#2fd4a4" />
      <circle cx="24" cy="44" r="2" fill="#2fd4a4" opacity="0.45" />
      <circle cx="38" cy="50" r="1.5" fill="#2fd4a4" opacity="0.25" />
    </svg>
  );
}

export function Logo({ size = 34 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <LogoMark size={size} />
      <span className="font-display text-[1.35rem] font-bold tracking-tight text-rail-ink">
        scuttledeck
      </span>
    </span>
  );
}
