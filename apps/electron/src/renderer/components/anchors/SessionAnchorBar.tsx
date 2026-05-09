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
import { Eye, Plus, Pin } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AnchorChip } from './AnchorChip'
import { AnchorPicker } from './AnchorPicker'
import { ObservationsViewer } from './ObservationsViewer'
import { EpisodesViewer } from './EpisodesViewer'
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
  const [viewerOpen, setViewerOpen] = React.useState(false)
  const [episodesOpen, setEpisodesOpen] = React.useState(false)
  const [runningObserver, setRunningObserver] = React.useState(false)
  const [runResult, setRunResult] = React.useState<{ ok: boolean; message: string } | null>(null)
  const { anchors, add, remove } = useSessionAnchors(sessionId)
  const observation = useObservationStatus(sessionDir ?? null)

  const handleRunObserver = React.useCallback(async () => {
    if (!sessionDir || runningObserver) return
    setRunningObserver(true)
    setRunResult(null)
    try {
      const result = await window.electronAPI.observationRunNow(sessionDir)
      if (result.ok) {
        setRunResult({ ok: true, message: result.output })
      } else {
        setRunResult({ ok: false, message: result.error })
      }
    } catch (err) {
      setRunResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setRunningObserver(false)
    }
  }, [sessionDir, runningObserver])

  const handleRewriteEchoes = React.useCallback(async () => {
    if (!sessionDir || runningObserver) return
    setRunningObserver(true)
    setRunResult(null)
    try {
      const result = await window.electronAPI.observationRewriteEchoes(sessionDir)
      if (result.ok) {
        setRunResult({ ok: true, message: result.output })
      } else {
        setRunResult({ ok: false, message: result.error })
      }
    } catch (err) {
      setRunResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setRunningObserver(false)
    }
  }, [sessionDir, runningObserver])

  const handleReflect = React.useCallback(async (force = false) => {
    if (!sessionDir || runningObserver) return
    setRunningObserver(true)
    setRunResult(null)
    try {
      const result = await window.electronAPI.observationReflectNow(sessionDir, { force })
      if (result.ok) {
        setRunResult({ ok: true, message: result.output })
      } else {
        setRunResult({ ok: false, message: result.error })
      }
    } catch (err) {
      setRunResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setRunningObserver(false)
    }
  }, [sessionDir, runningObserver])

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
          title={anchors.length === 0
            ? 'Set a focus anchor (Feature, Befund, Anliegen) so observations get scoped correctly'
            : undefined}
          className={cn(
            'inline-flex items-center gap-1 h-6 px-2 rounded-md text-xs transition-colors',
            anchors.length === 0
              // Empty state — more prominent: filled bg, accent text, pin icon
              ? 'border border-foreground/20 bg-foreground/[0.04] text-foreground/80 hover:bg-foreground/[0.08] hover:text-foreground'
              // Has anchors — discreet "+" affordance
              : 'border border-dashed border-border text-muted hover:border-foreground/30 hover:text-foreground hover:bg-foreground/5',
          )}
        >
          {anchors.length === 0 ? <Pin className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
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
                  'border select-none transition-colors',
                  observation.hasObserved
                    // Active: full foreground text on subtle bg, clear border
                    ? 'border-foreground/20 bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.10]'
                    // Idle: dimmer but still legible
                    : 'border-border bg-transparent text-foreground/70 hover:text-foreground hover:bg-foreground/5',
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
                    <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                      <span className="text-foreground/55">Last run</span>
                      <span className="text-foreground">{observation.relativeTime ?? 'just now'}</span>
                      <span className="text-foreground/55">Messages</span>
                      <span className="text-foreground">{observation.observedCount} observed</span>
                      <span className="text-foreground/55">Signals</span>
                      <span className="text-foreground">{observation.lastSignalCount} extracted</span>
                    </div>

                    <div className="border-t border-border pt-2 mt-2 space-y-1">
                      <div className="flex items-center gap-2 text-foreground/85">
                        <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
                        <span>Pivotal assertions</span>
                      </div>
                      <div className="flex items-center gap-2 text-foreground/85">
                        <span className="inline-block w-2 h-2 rounded-full bg-yellow-500" />
                        <span>Open questions</span>
                      </div>
                      <div className="flex items-center gap-2 text-foreground/85">
                        <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
                        <span>Context observations</span>
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="text-foreground/80 leading-relaxed">
                    No observations yet. The observer fires when the SDK
                    compacts the conversation (large token threshold), or
                    when triggered manually. Short sessions usually never
                    reach that point.
                  </p>
                )}

                <div className="border-t border-border pt-2 mt-2 space-y-1">
                  <button
                    type="button"
                    onClick={() => void handleRunObserver()}
                    disabled={runningObserver || !sessionDir}
                    className={cn(
                      'w-full text-left text-xs rounded px-2 py-1.5 transition-colors',
                      'text-foreground hover:bg-foreground/5',
                      'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent',
                    )}
                  >
                    {runningObserver ? 'Working…' : 'Run observer now'}
                  </button>

                  <button
                    type="button"
                    onClick={() => void handleRewriteEchoes()}
                    disabled={runningObserver || !sessionDir}
                    className={cn(
                      'w-full text-left text-xs rounded px-2 py-1.5 transition-colors',
                      'text-foreground hover:bg-foreground/5',
                      'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent',
                    )}
                    title="Re-extract any observation that mirrors its source message"
                  >
                    Rewrite echoes
                  </button>

                  <button
                    type="button"
                    onClick={() => void handleReflect(true)}
                    disabled={runningObserver || !sessionDir}
                    className={cn(
                      'w-full text-left text-xs rounded px-2 py-1.5 transition-colors',
                      'text-foreground hover:bg-foreground/5',
                      'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent',
                    )}
                    title="L2 condensation: combine related observations, drop superseded ones, bridge pivotal/question to Orcha-Ledger"
                  >
                    Reflect & condense (L2)
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setObserverOpen(false)
                      setViewerOpen(true)
                    }}
                    className="w-full text-left text-xs text-foreground hover:text-foreground/80 hover:bg-foreground/5 rounded px-2 py-1.5 transition-colors"
                  >
                    View observations →
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setObserverOpen(false)
                      setEpisodesOpen(true)
                    }}
                    className="w-full text-left text-xs text-foreground hover:text-foreground/80 hover:bg-foreground/5 rounded px-2 py-1.5 transition-colors"
                    title="Closed phases of this session — auto-emitted on session-done or anchor change"
                  >
                    View episodes →
                  </button>

                  {runResult && (
                    <div
                      className={cn(
                        'text-[11px] rounded px-2 py-1.5 mt-1 whitespace-pre-wrap break-words',
                        'max-h-48 overflow-y-auto font-mono',
                        runResult.ok
                          ? 'bg-green-500/10 text-green-700 dark:text-green-400'
                          : 'bg-red-500/10 text-red-700 dark:text-red-400',
                      )}
                    >
                      {runResult.message.length > 4000
                        ? runResult.message.slice(0, 4000) + '\n… (truncated)'
                        : runResult.message}
                    </div>
                  )}
                </div>
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

      <ObservationsViewer
        open={viewerOpen}
        onOpenChange={setViewerOpen}
        sessionDir={sessionDir}
      />

      <EpisodesViewer
        open={episodesOpen}
        onOpenChange={setEpisodesOpen}
        sessionDir={sessionDir}
      />
    </>
  )
}
