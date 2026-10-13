import { cn } from '@/lib/utils'
import { type SessionStatus, getStatusIconStyle } from '@/config/session-status-config'

interface StatusBadgeProps {
  status: SessionStatus
  className?: string
}

/**
 * Read-only workflow-status chip (design spec §2.4): a neutral chip with the user's status icon in
 * its configured color, plus the label — status is never carried by color alone. Independent from
 * the board column (a `needs-review` badge can sit in the In Progress column).
 */
export function StatusBadge({ status, className }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-xs bg-fill-hover pl-1 pr-1.5 text-label-sm text-secondary',
        className
      )}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center" style={getStatusIconStyle(status)} aria-hidden>
        {status.icon}
      </span>
      {status.label}
    </span>
  )
}
