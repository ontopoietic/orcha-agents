/**
 * SessionAnchorBar
 *
 * Inline bar showing the active anchors of a session as chips with a
 * trailing "+ Anchor" button that opens the AnchorPicker. Lives in the
 * TopBar / session-detail header. Renders nothing if no sessionId is
 * given.
 *
 * Mutations go through useSessionAnchors → sessionCommand RPC. The Jotai
 * meta atom updates via the 'anchors_changed' event stream, so this
 * component re-renders without manual state management.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Eye, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AnchorChip } from './AnchorChip'
import { AnchorPicker } from './AnchorPicker'
import { useSessionAnchors } from '@/hooks/useSessionAnchors'
import { useObservationStatus } from '@/hooks/useObservationStatus'

export interface SessionAnchorBarProps {
  sessionId: string | null | undefined
  workingDir: string | null | undefined
  /** Absolute path to the session directory (for observation watcher) */
  sessionDir?: string | null
  /** Override for the empty-state hint (default: "Add anchor") */
  addLabelKey?: string
  className?: string
}

export function SessionAnchorBar({ sessionId, workingDir, sessionDir, addLabelKey, className }: SessionAnchorBarProps) {
  const { t } = useTranslation()
  const [pickerOpen, setPickerOpen] = React.useState(false)
  const { anchors, add, remove } = useSessionAnchors(sessionId)

  const observation = useObservationStatus(sessionDir ?? null)

  if (!sessionId) return null

  return (
    <>
      <div className={cn('flex items-center gap-1.5 flex-wrap', className)}>
        {anchors.map((anchor) => (
          <AnchorChip
            key={`${anchor.type}:${anchor.id}`}
            anchor={anchor}
            onRemove={(a) => void remove({ type: a.type, id: a.id })}
          />
        ))}

        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className={cn(
            'inline-flex items-center gap-1 h-6 px-2 rounded-md text-xs',
            'border border-dashed border-border text-muted',
            'hover:border-foreground/30 hover:text-foreground hover:bg-foreground/5',
            'transition-colors',
          )}
        >
          <Plus className="h-3 w-3" />
          <span>{t(addLabelKey ?? (anchors.length === 0 ? 'anchors.addFirst' : 'anchors.add'))}</span>
        </button>

        {/* Observation status badge */}
        {observation.hasObserved && (
          <div
            className={cn(
              'inline-flex items-center gap-1 h-6 px-2 rounded-md text-xs',
              'border border-border bg-foreground/5 text-muted',
              'select-none',
            )}
            title={`Observer: ${observation.observedCount} messages observed, ${observation.lastSignalCount} signals extracted`}
          >
            <Eye className="h-3 w-3 opacity-70" />
            <span>{observation.lastSignalCount} observed{observation.relativeTime ? ` · ${observation.relativeTime}` : ''}</span>
          </div>
        )}
      </div>

      <AnchorPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        workingDir={workingDir}
        existing={anchors}
        onSelect={(anchor) => void add(anchor)}
      />
    </>
  )
}
