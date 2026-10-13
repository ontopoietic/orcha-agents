import * as React from 'react'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PROJECT_COLOR_PALETTE, type ProjectColorTreatment } from '@/utils/project-colors'
import { type SessionStatus, getStatusIconStyle } from '@/config/session-status-config'
import type { KanbanColumnColor } from '@/hooks/useKanbanColumnColors'
import { Button, IconButton } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { SessionStatusMenu } from '@/components/ui/session-status-menu'
import { TaskTile } from './TaskTile'
import { NewTaskComposer } from './NewTaskComposer'
import type {
  KanbanColumnMeta,
  KanbanModelProviderGroup,
  KanbanProject,
  KanbanTask,
} from './types'

interface KanbanColumnProps {
  column: KanbanColumnMeta
  /** Resolved color identity for this column (the header's color dot when no drop-status is set). */
  color?: KanbanColumnColor
  tasks: KanbanTask[]
  projectsById: Map<string, KanbanProject>
  statusesById: Map<string, SessionStatus>
  /** Ordered workspace statuses for the per-tile status picker. */
  statuses?: SessionStatus[]
  /** Change a task's status from its tile. Enables the status-badge picker when set. */
  onChangeStatus?: (taskId: string, statusId: string) => void
  treatment: ProjectColorTreatment
  expandedTaskIds: Set<string>
  onTaskClick?: (taskId: string) => void
  /** Open the editor against a tile (edit mode). Enables the tile's "Edit task" action. */
  onEditTask?: (taskId: string) => void
  onToggleSubtasks?: (taskId: string) => void
  onSubtaskClick?: (taskId: string, subtaskId: string) => void
  onAddSubtask?: (taskId: string, title: string, model: string) => void
  /** Run all pending subtasks of a task. Shows each tile's Play button when set. */
  onRunSubtasks?: (taskId: string) => void
  /** Provider→model catalog for each tile's "Add subtask" composer. */
  subtaskModelGroups?: KanbanModelProviderGroup[]
  /** Model id pre-selected in the composer. */
  defaultSubtaskModel?: string
  /** When present, the header gets a "+" that opens the inline "New Task" composer at the top of the column. */
  onCreateTask?: (title: string) => void
  /** Status auto-applied to a task dropped into this column (empty/undefined = leave untouched). */
  dropStatusId?: string
  /** The status this column stands for (its drop status, else the built-in column's own status).
   *  Tiles in that status skip their status chip — it would repeat the column header. */
  homeStatusId?: string
  /** Set this column's drop-status. Enables the header status picker when provided ('' clears). */
  onSelectDropStatus?: (statusId: string) => void
  /** Rename this (custom) column. Enables the column editor when provided. */
  onRename?: (name: string) => void
  /** Set this (custom) column's accent color. */
  onSetColor?: (color: string) => void
  /** Remove this (custom) column. Absent for the last remaining column (the board keeps one). */
  onRemove?: () => void
  /**
   * Where the dragged tile would land if dropped here (its recency slot), or undefined when no drag
   * is running or the tile already sits in this column. Drawn as the 4px accent drop bar while the
   * pointer is over the column — it shows where the card will actually go (cards sort by recency).
   */
  dropIndicatorIndex?: number
}

/**
 * One board column (design spec §7.14): a neutral 4.5% well (radius 12, 8px padding) with a 28px
 * header — status glyph · name · count · "+" — and no saturated washes or pill headers (L9).
 * Narrow panels (compact) stack the columns full-width; see KanbanBoard.
 */
export function KanbanColumn({
  column,
  color,
  tasks,
  projectsById,
  statusesById,
  statuses,
  onChangeStatus,
  treatment,
  expandedTaskIds,
  onTaskClick,
  onEditTask,
  onToggleSubtasks,
  onSubtaskClick,
  onAddSubtask,
  onRunSubtasks,
  subtaskModelGroups,
  defaultSubtaskModel,
  onCreateTask,
  dropStatusId,
  homeStatusId,
  onSelectDropStatus,
  onRename,
  onSetColor,
  onRemove,
  dropIndicatorIndex,
}: KanbanColumnProps) {
  const { t } = useTranslation()
  // Built-in columns carry an i18n key; custom (per-project) columns a verbatim name.
  const label = column.labelKey ? t(column.labelKey) : (column.name ?? '')
  const editable = !!onRename || !!onSetColor || !!onRemove
  // The inline "New Task" composer, opened from the header's "+" (first column only).
  const [composing, setComposing] = React.useState(false)
  // The whole full-height column is the drop target (the well inside only hugs its cards), so a
  // drop anywhere in the lane lands here; `isOver` shows the drop bar while a tile is dragged over.
  // The DndContext lives in KanbanBoard, so these hooks are only ever mounted under a provider
  // (the playground board mounts it too).
  const { setNodeRef, isOver } = useDroppable({ id: column.id })
  const dropIndex = isOver ? dropIndicatorIndex : undefined

  return (
    <section
      ref={setNodeRef}
      aria-label={label}
      className={cn(
        'flex min-h-0 min-w-[240px] max-w-[360px] flex-[1_1_260px] flex-col',
        // Compact shell: full-width columns stacked vertically, each as tall as its cards
        '@max-mobile/shell:max-w-none @max-mobile/shell:min-w-0 @max-mobile/shell:flex-none'
      )}
    >
      {/* The well: neutral 4.5% fill, radius 12, 8px padding; as tall as its cards (min 200px),
          scrolling inside once it reaches the board's height. */}
      <div
        className={cn(
          'flex max-h-full min-h-[200px] flex-col gap-2 rounded-lg bg-fill-hover p-2',
          '@max-mobile/shell:max-h-none @max-mobile/shell:min-h-0'
        )}
      >
        <div className="flex h-control shrink-0 items-center gap-1">
          <ColumnHeader
            label={label}
            count={tasks.length}
            color={color}
            statuses={statuses}
            dropStatus={dropStatusId ? statusesById.get(dropStatusId) : undefined}
            onSelectDropStatus={onSelectDropStatus}
            editable={editable}
            onRename={onRename}
            onSetColor={onSetColor}
            onRemove={onRemove}
          />
          {onCreateTask && (
            <IconButton
              size="sm"
              icon={<Plus />}
              aria-label={t('kanban.newTask')}
              tooltip
              className="ml-auto"
              onClick={() => setComposing(true)}
            />
          )}
        </div>

        {/* Scroll area. The 6px inset (−m-1.5 p-1.5) leaves room for the focus ring, the hover
            hairline and the drop bar without clipping, while cards stay aligned to the well.
            `data-kanban-scroll` lets KanbanBoard unclip short columns while cards settle. */}
        <div
          data-kanban-scroll=""
          className={cn(
            '-m-1.5 flex min-h-0 flex-col gap-2 overflow-y-auto p-1.5',
            '@max-mobile/shell:overflow-visible'
          )}
        >
          {onCreateTask && (
            <NewTaskComposer open={composing} onOpenChange={setComposing} onCreate={onCreateTask} />
          )}

          {tasks.length === 0 && dropIndex !== undefined && <DropBar />}

          {tasks.map((task, index) => (
            <DraggableTile
              key={task.id}
              taskId={task.id}
              dropBar={dropIndex === index ? 'before' : dropIndex === tasks.length && index === tasks.length - 1 ? 'after' : undefined}
            >
              <TaskTile
                task={task}
                project={task.projectId ? projectsById.get(task.projectId) : undefined}
                status={statusesById.get(task.statusId)}
                statuses={statuses}
                onStatusChange={onChangeStatus ? statusId => onChangeStatus(task.id, statusId) : undefined}
                columnStatusId={homeStatusId}
                treatment={treatment}
                expanded={expandedTaskIds.has(task.id)}
                onClick={() => onTaskClick?.(task.id)}
                onEdit={onEditTask ? () => onEditTask(task.id) : undefined}
                onToggleSubtasks={() => onToggleSubtasks?.(task.id)}
                onSubtaskClick={onSubtaskClick ? subtaskId => onSubtaskClick(task.id, subtaskId) : undefined}
                onAddSubtask={onAddSubtask ? (title, model) => onAddSubtask(task.id, title, model) : undefined}
                onRunSubtasks={onRunSubtasks ? () => onRunSubtasks(task.id) : undefined}
                subtaskModelGroups={subtaskModelGroups}
                defaultSubtaskModel={defaultSubtaskModel}
              />
            </DraggableTile>
          ))}
        </div>
      </div>
    </section>
  )
}

/** The drop indicator (spec §6.3 board drag): a 4px accent bar. In flow only for an empty column. */
function DropBar({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn('pointer-events-none h-1 shrink-0 rounded-full bg-accent-solid', className ?? '-my-0.5')}
    />
  )
}

/**
 * Column identity: status glyph (the drop-status icon in its configured color, else the column's
 * color dot) · name · count. Three modes, by capability:
 * - **plain** (no handlers): non-interactive (e.g. the playground board).
 * - **drop-status** (`onSelectDropStatus` only): the built-in board columns — the header opens a
 *   status menu choosing the status auto-applied on drop.
 * - **editable** (`editable` + rename/color/remove handlers): per-project custom columns — the
 *   header opens a full editor (rename, accent color, drop-status, remove).
 */
function ColumnHeader({
  label,
  count,
  color,
  statuses,
  dropStatus,
  onSelectDropStatus,
  editable,
  onRename,
  onSetColor,
  onRemove,
}: {
  label: string
  count: number
  color?: KanbanColumnColor
  statuses?: SessionStatus[]
  dropStatus?: SessionStatus
  onSelectDropStatus?: (statusId: string) => void
  editable?: boolean
  onRename?: (name: string) => void
  onSetColor?: (color: string) => void
  onRemove?: () => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)

  const inner = (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
        {dropStatus ? (
          <span className="flex items-center" style={getStatusIconStyle(dropStatus)}>
            {dropStatus.icon}
          </span>
        ) : color ? (
          <span className="size-2 rounded-full" style={{ backgroundColor: color.solid }} />
        ) : null}
      </span>
      <span className="truncate font-semibold">{label}</span>
      <span className="text-label-sm tabular-nums text-tertiary">{count}</span>
    </>
  )

  // Plain header: nothing to configure.
  if (!onSelectDropStatus && !editable) {
    return <span className="flex h-control min-w-0 items-center gap-2 px-2 text-label">{inner}</span>
  }

  const trigger = (
    <PopoverTrigger asChild>
      <button
        type="button"
        data-no-dnd="true"
        onPointerDown={e => e.stopPropagation()}
        title={editable ? t('kanban.column.edit') : t('kanban.column.setDropStatus')}
        className={cn(
          // px-2: the colour dot (centred in its 16px slot) lands on the cards' text edge
          'flex h-control min-w-0 items-center gap-2 rounded-md px-2 text-label text-foreground',
          'transition-colors duration-micro ease-out-subtle hover:bg-fill-hover hover:duration-instant data-[state=open]:bg-fill-hover'
        )}
      >
        {inner}
        <ChevronDown className="size-3.5 shrink-0 text-tertiary" />
      </button>
    </PopoverTrigger>
  )

  // Drop-status-only (built-in board columns).
  if (!editable) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        {trigger}
        <PopoverContent
          align="start"
          sideOffset={4}
          className="w-auto border-0 bg-transparent p-0 shadow-none"
          data-no-dnd="true"
        >
          <SessionStatusMenu
            states={statuses}
            activeState={dropStatus?.id ?? ''}
            onSelect={statusId => {
              onSelectDropStatus?.(statusId)
              setOpen(false)
            }}
            onClear={() => {
              onSelectDropStatus?.('')
              setOpen(false)
            }}
            clearLabel={t('kanban.column.dropStatusNone')}
          />
        </PopoverContent>
      </Popover>
    )
  }

  // Full editor for custom (per-project) columns — the standard floating material.
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {trigger}
      <PopoverContent align="start" sideOffset={4} className="w-64 space-y-3 p-3" data-no-dnd="true">
        {onRename && (
          <div className="space-y-1.5">
            <label className="text-label-sm font-medium text-tertiary">{t('kanban.column.name')}</label>
            <Input
              type="text"
              defaultValue={label}
              autoFocus
              onBlur={e => {
                const next = e.target.value.trim()
                if (next && next !== label) onRename(next)
              }}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  ;(e.target as HTMLInputElement).blur()
                  setOpen(false)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setOpen(false)
                }
              }}
              className="h-control"
            />
          </div>
        )}

        {onSetColor && (
          <div className="space-y-1.5">
            <label className="text-label-sm font-medium text-tertiary">{t('kanban.column.color')}</label>
            <div className="flex flex-wrap gap-2">
              {PROJECT_COLOR_PALETTE.map(hex => {
                const selected = color?.solid === hex
                return (
                  // Selected swatch: a ring in the text color around the swatch (shape, not a tint)
                  <button
                    key={hex}
                    type="button"
                    onClick={() => onSetColor(hex)}
                    title={hex}
                    aria-label={hex}
                    aria-pressed={selected}
                    className={cn(
                      'size-6 rounded-full ring-1 ring-border',
                      selected && 'ring-2 ring-foreground ring-offset-2 ring-offset-floating'
                    )}
                    style={{ backgroundColor: hex }}
                  />
                )
              })}
            </div>
          </div>
        )}

        {onSelectDropStatus && statuses && statuses.length > 0 && (
          <div className="space-y-1.5">
            <label className="text-label-sm font-medium text-tertiary">{t('kanban.column.setDropStatus')}</label>
            <SessionStatusMenu
              states={statuses}
              activeState={dropStatus?.id ?? ''}
              onSelect={statusId => onSelectDropStatus(statusId)}
              onClear={() => onSelectDropStatus('')}
              clearLabel={t('kanban.column.dropStatusNone')}
            />
          </div>
        )}

        {onRemove && (
          <Button
            type="button"
            variant="danger"
            size="md"
            className="w-full justify-start"
            onClick={() => {
              onRemove()
              setOpen(false)
            }}
          >
            <Trash2 />
            {t('kanban.column.remove')}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  )
}

/**
 * Pointer-drag wrapper for a tile. Only `listeners` are spread (not `attributes`)
 * so the wrapper doesn't add a competing `role="button"`/tab stop on top of the
 * TaskTile card, which already owns click/keyboard "open" semantics. The dragged
 * tile is hidden (the DragOverlay clone follows the cursor instead), avoiding the
 * column's `overflow-y-auto` clipping. `data-kanban-tile` lets KanbanBoard find the
 * tiles to animate after a drop (settle + neighbour glide).
 */
function DraggableTile({
  taskId,
  dropBar,
  children,
}: {
  taskId: string
  /** Draw the drop bar centered in the gap above ('before') or below ('after') this tile. */
  dropBar?: 'before' | 'after'
  children: React.ReactNode
}) {
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: taskId })
  return (
    <div
      ref={setNodeRef}
      data-kanban-tile={taskId}
      className="relative shrink-0"
      style={{ opacity: isDragging ? 0 : 1 }}
      {...listeners}
    >
      {children}
      {dropBar && (
        <DropBar className={cn('absolute inset-x-0', dropBar === 'before' ? '-top-1.5' : '-bottom-1.5')} />
      )}
    </div>
  )
}
