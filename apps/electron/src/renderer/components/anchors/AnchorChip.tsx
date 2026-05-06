/**
 * AnchorChip
 *
 * Compact pill rendering an AnchorRef. Shows a type-specific icon, the
 * snapshot title (truncated), and an optional remove (×) button. Used
 * inline in the SessionAnchorBar and reused in flat-mode list rows.
 */

import * as React from 'react'
import { Package, Bug, Inbox, X } from 'lucide-react'
import type { AnchorRef, AnchorType } from '@craft-agent/shared/sessions'
import { cn } from '@/lib/utils'

export interface AnchorChipProps {
  anchor: AnchorRef
  /** When provided, renders an × button that calls onRemove */
  onRemove?: (anchor: AnchorRef) => void
  /** When provided, the chip becomes a button calling onClick */
  onClick?: (anchor: AnchorRef) => void
  /** Visual size variant */
  size?: 'sm' | 'md'
  /** Additional className */
  className?: string
}

const ANCHOR_ICON: Record<AnchorType, React.ComponentType<{ className?: string }>> = {
  feature: Package,
  befund: Bug,
  anliegen: Inbox,
}

export function AnchorChip({ anchor, onRemove, onClick, size = 'sm', className }: AnchorChipProps) {
  const Icon = ANCHOR_ICON[anchor.type]
  const interactive = typeof onClick === 'function'

  const sizeClass =
    size === 'sm'
      ? 'h-6 px-2 text-xs gap-1'
      : 'h-7 px-2.5 text-sm gap-1.5'
  const iconSize = size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'

  const Wrapper: React.ElementType = interactive ? 'button' : 'div'

  return (
    <Wrapper
      type={interactive ? 'button' : undefined}
      onClick={interactive ? () => onClick!(anchor) : undefined}
      title={anchor.title || `${anchor.type}:${anchor.id}`}
      className={cn(
        'inline-flex items-center rounded-md border border-border bg-surface text-foreground',
        'max-w-[16rem] select-none',
        sizeClass,
        interactive && 'hover:bg-accent/10 cursor-pointer',
        className,
      )}
    >
      <Icon className={cn(iconSize, 'shrink-0 opacity-70')} />
      <span className="truncate">{anchor.title || anchor.id}</span>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRemove(anchor)
          }}
          className={cn(
            'ml-0.5 flex shrink-0 items-center justify-center rounded-sm opacity-60',
            'hover:bg-foreground/10 hover:opacity-100',
            size === 'sm' ? 'h-4 w-4' : 'h-5 w-5',
          )}
          aria-label="Remove anchor"
        >
          <X className={size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
        </button>
      )}
    </Wrapper>
  )
}
