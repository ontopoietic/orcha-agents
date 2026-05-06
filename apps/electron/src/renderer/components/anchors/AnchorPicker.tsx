/**
 * AnchorPicker — modal command picker for selecting an Orcha artifact
 * (Feature, Befund, Anliegen) to attach to a session as an anchor.
 *
 * Tabs across the three anchor types. Each tab pulls items from the
 * orcha CLI bridge via useAnchorables. Selecting an item resolves the
 * promise via onSelect with a fresh AnchorRef stamped with the chosen
 * type, id, snapshot title, addedAt, and addedBy='user'.
 *
 * If the bridge returns empty (orcha binary missing, no items, or
 * error), the picker still renders so users can dismiss without
 * confusion. A "Refresh" affordance forces a cache bypass.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Package, Bug, Inbox, RefreshCw, Search } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import {
  type AnchorRef,
  type AnchorType,
  type AnchorableItem,
  anchorFromItem,
  ANCHOR_TYPES,
} from '@craft-agent/shared/sessions'
import { useAnchorables } from '@/hooks/useAnchorables'

export interface AnchorPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workingDir: string | null | undefined
  /** Anchors already attached — used to disable items already chosen */
  existing?: AnchorRef[]
  onSelect: (anchor: AnchorRef) => void
}

const TAB_ICONS: Record<AnchorType, React.ComponentType<{ className?: string }>> = {
  feature: Package,
  befund: Bug,
  anliegen: Inbox,
}

export function AnchorPicker({ open, onOpenChange, workingDir, existing = [], onSelect }: AnchorPickerProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = React.useState<AnchorType>('feature')
  const [query, setQuery] = React.useState('')

  // Reset search when tab changes
  React.useEffect(() => {
    setQuery('')
  }, [activeTab])

  // Reset state when dialog closes/reopens
  React.useEffect(() => {
    if (!open) {
      setActiveTab('feature')
      setQuery('')
    }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg p-0 overflow-hidden">
        <DialogTitle className="sr-only">{t('anchors.pickerTitle')}</DialogTitle>

        <div className="flex border-b border-border">
          {ANCHOR_TYPES.map((type) => {
            const Icon = TAB_ICONS[type]
            const isActive = activeTab === type
            return (
              <button
                key={type}
                type="button"
                onClick={() => setActiveTab(type)}
                className={cn(
                  'flex-1 flex items-center justify-center gap-2 px-3 py-3 text-sm border-b-2 -mb-px transition-colors',
                  isActive
                    ? 'border-accent text-foreground'
                    : 'border-transparent text-muted hover:text-foreground',
                )}
              >
                <Icon className="h-4 w-4" />
                <span>{t(`anchors.type.${type}`)}</span>
              </button>
            )
          })}
        </div>

        <AnchorPickerTab
          type={activeTab}
          workingDir={workingDir ?? null}
          query={query}
          onQueryChange={setQuery}
          existing={existing}
          onSelect={(item) => {
            onSelect(anchorFromItem(item, 'user'))
            onOpenChange(false)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------

interface AnchorPickerTabProps {
  type: AnchorType
  workingDir: string | null
  query: string
  onQueryChange: (q: string) => void
  existing: AnchorRef[]
  onSelect: (item: AnchorableItem) => void
}

function AnchorPickerTab({ type, workingDir, query, onQueryChange, existing, onSelect }: AnchorPickerTabProps) {
  const { t } = useTranslation()
  const { items, isLoading, error, refresh } = useAnchorables(type, workingDir)

  const existingKeys = React.useMemo(() => {
    const set = new Set<string>()
    for (const a of existing) set.add(`${a.type}:${a.id}`)
    return set
  }, [existing])

  const filtered = React.useMemo(() => {
    if (!query.trim()) return items
    const q = query.toLowerCase()
    return items.filter(
      (it) =>
        it.title.toLowerCase().includes(q) ||
        (it.subtitle?.toLowerCase().includes(q) ?? false),
    )
  }, [items, query])

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Search className="h-4 w-4 shrink-0 text-muted" />
        <input
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={t('anchors.searchPlaceholder')}
          className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted"
          autoFocus
        />
        <button
          type="button"
          onClick={() => refresh()}
          className="p-1 rounded text-muted hover:text-foreground hover:bg-foreground/5"
          title={t('common.refresh')}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
        </button>
      </div>

      <div className="max-h-80 overflow-y-auto">
        {error && (
          <div className="px-4 py-3 text-sm text-error">{error}</div>
        )}
        {!error && filtered.length === 0 && !isLoading && (
          <div className="px-4 py-8 text-sm text-muted text-center">
            {query ? t('anchors.noMatches') : t('anchors.empty')}
          </div>
        )}
        {filtered.map((item) => {
          const isAttached = existingKeys.has(`${item.type}:${item.id}`)
          return (
            <button
              key={`${item.type}:${item.id}`}
              type="button"
              disabled={isAttached}
              onClick={() => !isAttached && onSelect(item)}
              className={cn(
                'w-full text-left px-4 py-2 hover:bg-foreground/5 transition-colors',
                'flex flex-col gap-0.5 border-b border-border/50 last:border-b-0',
                isAttached && 'opacity-50 cursor-not-allowed',
              )}
            >
              <span className="text-sm text-foreground truncate">{item.title}</span>
              {item.subtitle && (
                <span className="text-xs text-muted truncate">{item.subtitle}</span>
              )}
              {isAttached && (
                <span className="text-xs text-accent">{t('anchors.alreadyAttached')}</span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
