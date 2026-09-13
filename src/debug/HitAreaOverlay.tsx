import type { HitAreaResolver } from "../interaction/HitAreaResolver"

export function HitAreaOverlay({ resolver, width, height, visible }: { resolver: HitAreaResolver | null; width: number; height: number; visible: boolean }) {
  if (!resolver || !visible) return null
  return (
    <svg className="hit-overlay" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {Object.entries(resolver.areas).map(([name, bounds]) => (
        <g key={name}>
          <rect className={`hit-box hit-${name}`} x={bounds.x0} y={bounds.y0} width={bounds.x1 - bounds.x0} height={bounds.y1 - bounds.y0} rx="8" />
          <text x={bounds.x0 + 8} y={bounds.y0 + 20}>{name}</text>
        </g>
      ))}
    </svg>
  )
}
