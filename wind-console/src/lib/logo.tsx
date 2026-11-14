// The Wind mark: three curl strokes, balanced on a 24px grid. The top two
// curls loop back into themselves, the third is a short tail. Stroke width
// holds at any size; no fill, so it inherits the current color.
export function WindMark({ size = 24, stroke = 1.8, className }: { size?: number; stroke?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden="true">
      <path d="M3 8.5h11a2.75 2.75 0 1 0-2.75-2.75" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" />
      <path d="M2 13h16.5a3.25 3.25 0 1 1-3.25 3.25" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" />
      <path d="M6 17.5h7.5" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" />
    </svg>
  );
}

// Brand-tile variant: the mark on the accent field used for avatars.
export function WindTile({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <span
      className={className}
      style={{
        width: size,
        height: size,
        display: "inline-grid",
        placeItems: "center",
        borderRadius: Math.max(6, size * 0.32),
        background: "var(--accent)",
        color: "var(--accent-foreground)"
      }}
      aria-hidden="true"
    >
      <WindMark size={size * 0.68} stroke={2} />
    </span>
  );
}
