/**
 * ObservationsViewer
 *
 * Read-only viewer for the observations the Observer has extracted from a
 * session's conversation. Lets the user audit Observer output before we
 * start trusting it as a replacement for SDK compaction.
 *
 * Renders observations grouped by salience (🔴 pivotal / 🟡 question /
 * 🟢 context), newest first within each group. Each entry shows summary,
 * actor, message-range, excerpt, and timestamp.
 */

import * as React from 'react'
import { Eye, RefreshCw } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useObservations } from '@/hooks/useObservations'
import { useNavigation } from '@/contexts/NavigationContext'
import type { ObservationSignal } from '@craft-agent/shared/sessions'
import { cn } from '@/lib/utils'
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton'
import { useOptionalAppShellContext } from '@/context/AppShellContext'

export interface ObservationsViewerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionDir: string | null | undefined
}

type Salience = 'pivotal' | 'question' | 'context'

const SALIENCE_ORDER: Salience[] = ['pivotal', 'question', 'context']

const SALIENCE_META: Record<Salience, { label: string; dot: string; emoji: string }> = {
  pivotal: { label: 'Pivotal', dot: 'bg-red-500', emoji: '🔴' },
  question: { label: 'Questions', dot: 'bg-yellow-500', emoji: '🟡' },
  context: { label: 'Context', dot: 'bg-green-500', emoji: '🟢' },
}

function normalizeSalience(s: string | undefined): Salience {
  if (s === 'pivotal' || s === 'question' || s === 'context') return s
  return 'context'
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      day: '2-digit',
      month: 'short',
    })
  } catch {
    return iso
  }
}

/** Strip the leading emoji + LABEL prefix the observer adds to summaries. */
function stripPrefix(summary: string): string {
  return summary.replace(/^[\p{Emoji}]?\s?(USER STATED|USER ASKED|OBSERVED):\s*/u, '')
}

/** Visible-line cap before a "Show more" toggle is rendered. */
const SUMMARY_CLAMP_CHARS = 120
const EXCERPT_CLAMP_CHARS = 160

function ObservationCard({ obs, onSessionClick }: {
  obs: ObservationSignal
  /** When set, a session badge is rendered (workspace scope) and clicking it navigates there. */
  onSessionClick?: (sessionId: string) => void
}) {
  const salience = normalizeSalience(obs.salience)
  const meta = SALIENCE_META[salience]
  const actor = obs.conversation?.actor
  const range = obs.conversation?.messageRange
  const excerpt = obs.conversation?.excerpt
  const sessionId = obs.conversation?.sessionId

  const [expanded, setExpanded] = React.useState(false)

  const fullSummary = stripPrefix(obs.summary)
  const summaryLong = fullSummary.length > SUMMARY_CLAMP_CHARS
  const summaryShown = expanded || !summaryLong
    ? fullSummary
    : fullSummary.slice(0, SUMMARY_CLAMP_CHARS).trimEnd() + '…'

  const excerptLong = (excerpt?.length ?? 0) > EXCERPT_CLAMP_CHARS
  const excerptShown = excerpt
    ? expanded || !excerptLong
      ? excerpt
      : excerpt.slice(0, EXCERPT_CLAMP_CHARS).trimEnd() + '…'
    : null

  // Detect "echo" — summary equals or is a prefix of excerpt. Indicates the
  // LLM extractor copy-pasted the user message instead of summarizing. Marked
  // visually so the user can spot quality issues without reading every entry.
  //
  // Markdown is stripped before comparison: cleanSummary (pattern fallback)
  // removes **bold**/`code`/headings/links, but the excerpt is stored raw.
  // Without normalisation, an obvious echo like "Follow-ups …" vs raw
  // "**Follow-ups** …" never matches.
  const stripMd = (s: string) =>
    s
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/^[ \t]*#+\s*/gm, '')
      .replace(/^[ \t]*>\s?/gm, '')
      .replace(/…/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
  const normSummary = stripMd(fullSummary)
  const normExcerpt = excerpt ? stripMd(excerpt) : ''
  const looksLikeEcho = normExcerpt && normSummary.length > 30 && (
    normExcerpt.startsWith(normSummary.slice(0, 60)) ||
    normSummary.startsWith(normExcerpt.slice(0, 60))
  )

  const canExpand = summaryLong || excerptLong

  return (
    <div
      className={cn(
        'rounded-md border p-3 space-y-2 bg-background',
        looksLikeEcho ? 'border-yellow-500/40' : 'border-border',
      )}
    >
      <div className="flex items-start gap-2">
        <span className={cn('inline-block w-2 h-2 rounded-full mt-1.5 shrink-0', meta.dot)} />
        <div className="flex-1 min-w-0">
          <div className="text-sm text-foreground leading-snug whitespace-pre-wrap break-words">{summaryShown}</div>
          <div className="flex items-center gap-2 mt-1 text-[11px] text-foreground/60 flex-wrap">
            {onSessionClick && sessionId && (
              <>
                <button
                  type="button"
                  onClick={() => onSessionClick(sessionId)}
                  className="font-mono text-foreground/70 hover:text-foreground hover:underline transition-colors"
                  title="Go to source session"
                >
                  {sessionId}
                </button>
                <span>·</span>
              </>
            )}
            {actor && <span className="capitalize">{actor}</span>}
            {actor && <span>·</span>}
            <span>{formatTime(obs.createdAt)}</span>
            {range?.from && range?.to && (
              <>
                <span>·</span>
                <span title={`${range.from} → ${range.to}`}>
                  {range.from === range.to
                    ? range.from.slice(0, 10) + '…'
                    : `${range.from.slice(0, 8)}…${range.to.slice(-4)}`}
                </span>
              </>
            )}
            {looksLikeEcho && (
              <>
                <span>·</span>
                <span className="text-yellow-600 dark:text-yellow-400" title="Summary mirrors source message — extractor likely echoed instead of summarizing">
                  echo?
                </span>
              </>
            )}
          </div>
        </div>
      </div>
      {excerptShown && (
        <div className="text-xs text-foreground/70 italic pl-4 border-l-2 border-border ml-1 whitespace-pre-wrap break-words">
          “{excerptShown}”
        </div>
      )}
      {canExpand && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-[11px] text-foreground/60 hover:text-foreground transition-colors"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

/**
 * The card-grid body, reusable between the dialog overlay and the full-page
 * split-view variant. Pulled out so ObservationsDetailPage can mount the
 * same UI without the Dialog chrome.
 */
export function ObservationsContent({ sessionDir, onNavigateToSession }: {
  sessionDir: string | null | undefined
  /** Navigate to a source session (workspace scope). Provided by the mounting context. */
  onNavigateToSession?: (sessionId: string) => void
}) {
  const [scope, setScope] = React.useState<'session' | 'workspace'>('session')
  const { observations, loading, refresh } = useObservations(sessionDir, { scope })
  const shellContext = useOptionalAppShellContext()
  const closeButton = shellContext?.rightSidebarButton

  const [spinning, setSpinning] = React.useState(false)
  const handleRefresh = React.useCallback(() => {
    setSpinning(true)
    const minDelay = new Promise((r) => setTimeout(r, 600))
    void Promise.all([refresh(), minDelay]).finally(() => setSpinning(false))
  }, [refresh])
  const isSpinning = spinning || loading

  const grouped = React.useMemo(() => {
    const buckets: Record<Salience, ObservationSignal[]> = {
      pivotal: [],
      question: [],
      context: [],
    }
    for (const obs of observations) {
      const s = normalizeSalience(obs.salience)
      buckets[s].push(obs)
    }
    for (const s of SALIENCE_ORDER) {
      buckets[s].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    }
    return buckets
  }, [observations])

  const totals = {
    pivotal: grouped.pivotal.length,
    question: grouped.question.length,
    context: grouped.context.length,
    all: observations.length,
  }

  return (
    <div className="h-full flex flex-col">
      <header className="px-6 py-3 border-b border-border flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <Eye className="h-4 w-4" />
          <span className="font-semibold">Observations</span>
          <span className="text-xs font-normal text-foreground/70 ml-2">
            {totals.all} total · 🔴 {totals.pivotal} · 🟡 {totals.question} · 🟢 {totals.context}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="flex items-center rounded-md border border-border text-xs overflow-hidden">
            <button
              type="button"
              onClick={() => setScope('session')}
              className={cn(
                'px-2 py-1 transition-colors',
                scope === 'session' ? 'bg-foreground/10 text-foreground' : 'text-foreground/60 hover:text-foreground',
              )}
            >
              This session
            </button>
            <button
              type="button"
              onClick={() => setScope('workspace')}
              className={cn(
                'px-2 py-1 transition-colors border-l border-border',
                scope === 'workspace' ? 'bg-foreground/10 text-foreground' : 'text-foreground/60 hover:text-foreground',
              )}
            >
              All sessions
            </button>
          </div>
          <PanelHeaderCenterButton
            icon={<RefreshCw className={cn('h-4 w-4', isSpinning && 'animate-spin')} />}
            onClick={handleRefresh}
            tooltip="Refresh"
            disabled={isSpinning}
          />
          {closeButton}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
        {loading && observations.length === 0 && (
          <div className="text-sm text-foreground/70 py-8 text-center">Loading observations…</div>
        )}

        {!loading && observations.length === 0 && (
          <div className="text-sm text-foreground/70 py-8 text-center">
            No observations yet. The observer runs before context compaction
            (or when triggered manually) and writes structured signals here.
          </div>
        )}

        {SALIENCE_ORDER.map((salience) => {
          const items = grouped[salience]
          if (items.length === 0) return null
          const meta = SALIENCE_META[salience]
          return (
            <section key={salience} className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground/75 flex items-center gap-2">
                <span className={cn('inline-block w-2 h-2 rounded-full', meta.dot)} />
                {meta.label} ({items.length})
              </h3>
              <div className="space-y-2">
                {items.map((obs) => (
                  <ObservationCard
                    // IDs are only unique within one session — qualify with the
                    // source sessionId so workspace scope can't collide keys.
                    key={`${obs.conversation?.sessionId ?? ''}:${obs.id}`}
                    obs={obs}
                    onSessionClick={scope === 'workspace' ? onNavigateToSession : undefined}
                  />
                ))}
              </div>
            </section>
          )
        })}
      </div>

      <footer className="px-6 py-2 border-t border-border text-xs text-foreground/65 shrink-0">
        Sources (merged): <code className="text-foreground/70">observations.mastra.md</code>
        {' · '}<code className="text-foreground/70">observations.md</code>
        {' (each with its own evidence sidecar; Mastra wins on duplicate anchor)'}
      </footer>
    </div>
  )
}

export function ObservationsViewer({ open, onOpenChange, sessionDir }: ObservationsViewerProps) {
  const { navigateToSession } = useNavigation()
  const handleNavigate = React.useCallback(
    (sessionId: string) => {
      onOpenChange(false)
      navigateToSession(sessionId)
    },
    [onOpenChange, navigateToSession],
  )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col p-0 overflow-hidden">
        <DialogHeader className="sr-only">
          <DialogTitle>Observations</DialogTitle>
        </DialogHeader>
        <ObservationsContent sessionDir={sessionDir} onNavigateToSession={handleNavigate} />
      </DialogContent>
    </Dialog>
  )
}
