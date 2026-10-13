import { cn } from '@/lib/utils'
import type { KanbanSubtask, SubtaskRunState } from './types'

interface SubtaskProgressProps {
  subtasks: KanbanSubtask[]
  /**
   * Total expected subtasks (the denominator). Defaults to `subtasks.length`. When larger — e.g. a
   * Conductor run whose child sessions spawn lazily — the extra slots render as pending filler so the
   * count and bar stay stable instead of growing as children appear.
   */
  total?: number
  /**
   * @deprecated Segments now take their color from the run-state roles (done = success,
   * running = accent, failed = destructive); kept so existing callers still type-check.
   */
  accent?: string
  className?: string
}

/** One status vocabulary (design spec §2.4): segment color = run-state role, pending = quiet track. */
const SEGMENT_CLASS: Record<SubtaskRunState, string> = {
  done: 'bg-current text-success',
  running: 'bg-current text-accent',
  failed: 'bg-current text-destructive',
  pending: 'bg-fill-pressed',
}

/**
 * One segment per subtask, colored by run state, with a trailing `done/total` count for the exact
 * tally (so progress is never read from color alone). Renders nothing when there are no subtasks.
 */
export function SubtaskProgress({ subtasks, total: totalProp, className }: SubtaskProgressProps) {
  const revealed = subtasks.length
  // Never let the denominator drop below what's already revealed (guards a stale/low total).
  const total = Math.max(totalProp ?? revealed, revealed)
  if (total === 0) return null
  const done = subtasks.filter(s => s.runState === 'done').length
  const unrevealed = total - revealed

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div
        className="flex flex-1 gap-0.5"
        role="progressbar"
        aria-valuenow={done}
        aria-valuemin={0}
        aria-valuemax={total}
      >
        {subtasks.map(subtask => (
          <span key={subtask.id} className={cn('h-1 flex-1 rounded-full', SEGMENT_CLASS[subtask.runState])} />
        ))}
        {Array.from({ length: unrevealed }, (_, i) => (
          <span key={`pending-${i}`} className={cn('h-1 flex-1 rounded-full', SEGMENT_CLASS.pending)} />
        ))}
      </div>
      <span className="shrink-0 text-label-sm font-medium tabular-nums text-tertiary">
        {done}/{total}
      </span>
    </div>
  )
}
