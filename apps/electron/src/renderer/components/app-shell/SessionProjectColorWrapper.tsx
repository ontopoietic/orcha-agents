import * as React from 'react'
import type { ProjectColorTreatment } from '@/utils/project-colors'

interface SessionProjectColorWrapperProps {
  /** Hex color (e.g. "#6366f1") to apply, or null/undefined to render children without overlay */
  color: string | null | undefined
  /** Visual treatment to apply when `color` is present */
  treatment: ProjectColorTreatment
  children: React.ReactNode
}

/**
 * Wraps a SessionItem row with a project-color overlay.
 *
 * - Always renders a 3px colored stripe on the row's leading edge when a color is set.
 * - Optionally adds a subtle background tint when treatment === 'stripe-tint'.
 *
 * Rows are full-bleed (mail-style), so the stripe is the row's leading edge at the panel edge, full
 * height, and the tint covers the whole row. z-[1] keeps the stripe above the row's own fill but
 * below the sticky group headers (z-sticky), which it used to paint over.
 *
 * Does NOT touch the SessionItem internals. The stripe/tint render on the wrapper
 * so the inner `EntityRow` (with its own selected/hover backgrounds) composites
 * cleanly on top — selection always reads correctly.
 */
export function SessionProjectColorWrapper({
  color,
  treatment,
  children,
}: SessionProjectColorWrapperProps) {
  if (!color) return <>{children}</>

  const showTint = treatment === 'stripe-tint'

  return (
    <div className="relative">
      {showTint && (
        <div
          className="pointer-events-none absolute inset-0"
          style={{ backgroundColor: `color-mix(in srgb, ${color} 6%, transparent)` }}
          aria-hidden
        />
      )}
      <div
        className="pointer-events-none absolute left-0 inset-y-0 z-[1] w-[3px]"
        style={{ backgroundColor: color }}
        aria-hidden
      />
      {children}
    </div>
  )
}
