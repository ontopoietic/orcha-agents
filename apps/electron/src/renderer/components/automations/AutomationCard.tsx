/**
 * AutomationCard
 *
 * Expandable inline row for compact automation display.
 * Collapsed: shows name + summary. Expanded: shows trigger, actions, and controls.
 */

import * as React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AutomationAvatar } from './AutomationAvatar'
import { AutomationActionPreview } from './AutomationActionPreview'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { getEventDisplayName, type AutomationListItem } from './types'

export interface AutomationCardProps {
  automation: AutomationListItem
  defaultExpanded?: boolean
  onToggleEnabled?: (enabled: boolean) => void
  onTest?: () => void
  className?: string
}

export function AutomationCard({
  automation,
  defaultExpanded = false,
  onToggleEnabled,
  onTest,
  className,
}: AutomationCardProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(defaultExpanded)

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg bg-raised shadow-elev-1',
        !automation.enabled && 'opacity-50',
        className
      )}
    >
      {/* Collapsed header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-3 px-3.5 py-3 text-left -outline-offset-2 transition-colors duration-micro ease-out-subtle hover:bg-fill-hover hover:duration-instant"
      >
        {/* Expand chevron */}
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-tertiary" aria-hidden />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-tertiary" aria-hidden />
        )}

        {/* Avatar */}
        <AutomationAvatar event={automation.event} size="sm" />

        {/* Name + summary */}
        <div className="flex-1 min-w-0">
          <div className="truncate text-label font-medium text-foreground">{automation.name}</div>
          <div className="truncate text-label-sm text-tertiary">{automation.summary}</div>
        </div>

        {/* Enable toggle */}
        <div onClick={(e) => e.stopPropagation()}>
          <Switch
            checked={automation.enabled}
            onCheckedChange={(checked) => onToggleEnabled?.(checked)}
          />
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="space-y-3 border-t border-subtle px-3.5 py-3">
          {/* Trigger info */}
          <div className="space-y-1">
            <h5 className="text-label-sm font-medium text-tertiary">{t('automations.sectionWhen')}</h5>
            <div className="text-label-sm text-secondary">
              <span className="font-medium">{getEventDisplayName(automation.event)}</span>
              {automation.matcher && (
                <span className="ml-2">
                  {t('automations.matching')} <code className="rounded-xs bg-fill-hover px-1 font-mono">{automation.matcher}</code>
                </span>
              )}
              {automation.cron && (
                <span className="ml-2">
                  {t('automations.at')} <code className="rounded-xs bg-fill-hover px-1 font-mono">{automation.cron}</code>
                </span>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="space-y-1">
            <h5 className="text-label-sm font-medium text-tertiary">{t('automations.sectionThen')}</h5>
            <AutomationActionPreview actions={automation.actions} />
          </div>

          {/* Actions bar */}
          <div className="flex items-center gap-2 pt-1">
            {onTest && (
              <Button variant="secondary" size="sm" onClick={onTest}>
                {t('automations.runTest')}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
