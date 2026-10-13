import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

interface NewTaskComposerProps {
  /** Whether the composer is open. The column header's "+" (KanbanColumn) opens it. */
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Create a task tile from the typed title. Fire-and-forget — the tile appears via the atom update. */
  onCreate: (title: string) => void
  className?: string
}

/**
 * Inline "new task" field at the top of the ToDo column, opened from the column header's "+".
 * Enter creates the tile in place (no navigation) and stays open so several tasks can be added in
 * a row; Escape discards; blur commits any pending title and collapses. Mirrors the subtask
 * composer so a tile is born named rather than as an empty "New chat".
 */
export function NewTaskComposer({ open, onOpenChange, onCreate, className }: NewTaskComposerProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = React.useState('')
  const inputRef = React.useRef<HTMLTextAreaElement>(null)

  React.useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const commit = (keepOpen: boolean) => {
    const title = draft.trim()
    if (title) {
      onCreate(title)
      setDraft('')
    }
    if (keepOpen && title) inputRef.current?.focus()
    else onOpenChange(false)
  }

  if (!open) return null

  return (
    <textarea
      ref={inputRef}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          commit(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          setDraft('')
          onOpenChange(false)
        }
      }}
      onBlur={() => commit(false)}
      rows={1}
      placeholder={t('kanban.newTaskTitle')}
      className={cn(
        // A field (sunken well + focus tint) shaped like the card it creates: same radius, padding and title type
        'field-surface w-full shrink-0 resize-none rounded-md px-3 py-2.5 text-label font-medium field-sizing-content max-h-40',
        className
      )}
    />
  )
}
