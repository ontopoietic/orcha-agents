/**
 * SessionAnchorBar
 *
 * Inline bar showing the active anchors of a session as chips with a
 * trailing "+ Anchor" button that opens the AnchorPicker. Lives in the
 * TopBar / session-detail header. Renders nothing if no sessionId is
 * given.
 *
 * Also shows an always-visible 👁 observer indicator with the last run
 * time. Clicking it opens a popover with detailed observation stats.
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
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
  const [observerOpen, setObserverOpen] = React.useState(false)
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

        {/* Always-visible observer indicator */}
        {sessionDir && (
          <Popover open={observerOpen} onOpenChange={setObserverOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(
                  'inline-flex items-center gap-1 h-6 px-2 rounded-md text-xs',
                  'border border-border select-none transition-colors',
                  observation.hasObserved
                    ? 'bg-foreground/5 text-muted hover:bg-foreground/10'
                    : 'bg-transparent text-muted/50 hover:text-muted hover:bg-foreground/5',
                )}
              >
                <Eye className="h-3 w-3" />
                <span>
                  {observation.hasObserved
                    ? observation.relativeTime
                      ? `${observation.lastSignalCount} · ${observation.relativeTime}`
                      : `${observation.lastSignalCount} observed`
                    : 'not yet'}
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent
              side="bottom"
              align="end"
              sideOffset={6}
              className="w-[280px] rounded-[8px] bg-background text-foreground shadow-modal-small p-3 border border-border"
            >
              <div className="space-y-2 text-xs">
                <div className="flex items-center gap-1.5 font-medium text-sm">
                  <Eye className="h-4 w-4" />
                  <span>Observer</span>
                </div>

                {observation.hasObserved ? (
                  <>
                    <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted">
                      <span className="text-foreground/60">Last run</span>
                      <span>{observation.relativeTime ?? 'just now'}</span>
                      <span className="text-foreground/60">Messages</span>
                      <span>{observation.observedCount} observed</span>
                      <span className="text-foreground/60">Signals</span>
                      <span>{observation.lastSignalCount} extracted</span>
                    </div>

                    <div className="border-t border-border pt-2 mt-2 space-y-1">
                      <div className="flex items-center gap-2 text-muted">
                        <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
                        <span>Pivotal assertions</span>
                      </div>
                      <div className="flex items-center gap-2 text-muted">
                        <span className="inline-block w-2 h-2 rounded-full bg-yellow-500" />
                        <span>Open questions</span>
                      </div>
                      <div className="flex items-center gap-2 text-muted">
                        <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
                        <span>Context observations</span>
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="text-muted">
                    The observer will run automatically before context compaction.
                    It extracts structured signals to preserve important information.
                  </p>
                )}
              </div>
            </PopoverContent>
          </Popover>
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
