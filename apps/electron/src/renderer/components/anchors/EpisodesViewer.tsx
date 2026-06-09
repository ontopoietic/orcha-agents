/**
 * EpisodesViewer
 *
 * Read-only viewer for the per-session episode index. Lists closed phases
 * with their summary, anchors, decisions count, outcome.
 *
 * Post-B2-pivot this is a purely HUMAN-facing phase-timeline digest (a "what
 * happened when" view). It is NOT agent memory: the agent's cross-session
 * recall reads the observation ledgers via the `recall` tool, not this index.
 * Phase A walking skeleton — no detail panel yet, no manual close button.
 */
import * as React from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useEpisodes } from '@/hooks/useEpisodes'
import type { EpisodeIndexEntry, EpisodeOutcome, EpisodeCloseReason } from '@craft-agent/shared/sessions'
import { cn } from '@/lib/utils'

export interface EpisodesViewerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionDir: string | null | undefined
}

const OUTCOME_META: Record<EpisodeOutcome, { label: string; color: string }> = {
  resolved: { label: 'resolved', color: 'text-green-600 bg-green-100 dark:bg-green-900/30' },
  blocked: { label: 'blocked', color: 'text-red-600 bg-red-100 dark:bg-red-900/30' },
  abandoned: { label: 'abandoned', color: 'text-zinc-500 bg-zinc-100 dark:bg-zinc-800' },
  handoff: { label: 'handoff', color: 'text-blue-600 bg-blue-100 dark:bg-blue-900/30' },
  unknown: { label: 'unknown', color: 'text-zinc-500 bg-zinc-100 dark:bg-zinc-800' },
}

const REASON_META: Record<EpisodeCloseReason, string> = {
  'session-done': 'session done',
  'anchor-change': 'anchor change',
  'idle-cutoff': 'idle cutoff',
  manual: 'manual',
}

function formatRange(startedAt: string, endedAt: string): string {
  try {
    const s = new Date(startedAt)
    const e = new Date(endedAt)
    const sameDay = s.toDateString() === e.toDateString()
    const opts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }
    const startStr = s.toLocaleString(undefined, sameDay
      ? { ...opts, day: '2-digit', month: 'short' }
      : { ...opts, day: '2-digit', month: 'short' })
    const endStr = sameDay
      ? e.toLocaleString(undefined, opts)
      : e.toLocaleString(undefined, { ...opts, day: '2-digit', month: 'short' })
    return `${startStr} → ${endStr}`
  } catch {
    return `${startedAt} → ${endedAt}`
  }
}

function EpisodeRow({ entry }: { entry: EpisodeIndexEntry }) {
  const outcomeMeta = OUTCOME_META[entry.outcome] ?? OUTCOME_META.unknown
  return (
    <div className="rounded-md border border-zinc-200 dark:border-zinc-800 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-zinc-500">
          {formatRange(entry.startedAt, entry.endedAt)} · {REASON_META[entry.closeReason]}
        </div>
        <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium', outcomeMeta.color)}>
          {outcomeMeta.label}
        </span>
      </div>
      {entry.anchors.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {entry.anchors.map((a, i) => (
            <span key={`${a.type}-${a.id}-${i}`} className="text-xs px-2 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300">
              {a.title ?? a.id}
            </span>
          ))}
        </div>
      )}
      <div className="text-sm text-zinc-800 dark:text-zinc-200">
        {entry.summarySnippet || <span className="italic text-zinc-400">no summary</span>}
      </div>
      <div className="flex items-center gap-3 text-xs text-zinc-500">
        <span>{entry.decisionsCount} decision{entry.decisionsCount === 1 ? '' : 's'}</span>
        <span>{entry.openQuestionsCount} question{entry.openQuestionsCount === 1 ? '' : 's'}</span>
        <span>{entry.artifactsCount} artifact{entry.artifactsCount === 1 ? '' : 's'}</span>
      </div>
    </div>
  )
}

export function EpisodesViewer({ open, onOpenChange, sessionDir }: EpisodesViewerProps) {
  const { entries, loading } = useEpisodes(sessionDir)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Episodes ({entries.length})</DialogTitle>
        </DialogHeader>
        {loading && entries.length === 0 ? (
          <div className="text-sm text-zinc-500 italic">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="text-sm text-zinc-500 italic">
            No closed phases yet. Episodes are written when this session is marked done or its anchors change.
          </div>
        ) : (
          <div className="space-y-3">
            {entries.map((e) => (
              <EpisodeRow key={e.id} entry={e} />
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
