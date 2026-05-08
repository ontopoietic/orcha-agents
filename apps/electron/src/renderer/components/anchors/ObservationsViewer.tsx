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
import { Eye } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useObservations } from '@/hooks/useObservations'
import type { ObservationSignal } from '@craft-agent/shared/sessions'
import { cn } from '@/lib/utils'

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

function ObservationCard({ obs }: { obs: ObservationSignal }) {
  const salience = normalizeSalience(obs.salience)
  const meta = SALIENCE_META[salience]
  const actor = obs.conversation?.actor
  const range = obs.conversation?.messageRange
  const excerpt = obs.conversation?.excerpt

  return (
    <div className="rounded-md border border-border p-3 space-y-2 bg-background">
      <div className="flex items-start gap-2">
        <span className={cn('inline-block w-2 h-2 rounded-full mt-1.5 shrink-0', meta.dot)} />
        <div className="flex-1 min-w-0">
          <div className="text-sm text-foreground leading-snug">{stripPrefix(obs.summary)}</div>
          <div className="flex items-center gap-2 mt-1 text-[11px] text-foreground/60">
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
          </div>
        </div>
      </div>
      {excerpt && (
        <div className="text-xs text-foreground/70 italic pl-4 border-l-2 border-border ml-1">
          “{excerpt.length > 240 ? excerpt.slice(0, 240) + '…' : excerpt}”
        </div>
      )}
    </div>
  )
}

export function ObservationsViewer({ open, onOpenChange, sessionDir }: ObservationsViewerProps) {
  const { observations, loading, refresh } = useObservations(sessionDir)

  // Group + sort: salience order, newest first within group
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Eye className="h-4 w-4" />
            Observations
            <span className="text-xs font-normal text-foreground/70 ml-2">
              {totals.all} total · 🔴 {totals.pivotal} · 🟡 {totals.question} · 🟢 {totals.context}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto -mx-6 px-6 space-y-6">
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
                    <ObservationCard key={obs.id} obs={obs} />
                  ))}
                </div>
              </section>
            )
          })}
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-border text-xs text-foreground/65">
          <span>Source: <code className="text-foreground/70">data/observations.json</code></span>
          <button
            type="button"
            onClick={() => void refresh()}
            className="hover:text-foreground transition-colors"
          >
            Refresh
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
