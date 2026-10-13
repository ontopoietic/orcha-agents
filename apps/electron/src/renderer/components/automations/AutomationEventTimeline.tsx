/**
 * AutomationEventTimeline
 *
 * Compact timeline showing recent automation executions.
 * Displayed as a section within AutomationInfoPage.
 * Webhook entries are expandable to show execution details.
 */

import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, XCircle, ShieldAlert, CircleSlash, ChevronDown, Copy, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { IconButton } from '@/components/ui/button'
import { useNavigation } from '@/contexts/NavigationContext'
import { type ExecutionEntry, type ExecutionStatus } from './types'
import { formatShortRelativeTime } from './utils'

// ============================================================================
// Helpers
// ============================================================================

const statusConfig: Record<ExecutionStatus, { icon: React.ElementType; classes: string }> = {
  success: { icon: CheckCircle2, classes: 'text-success' },
  error:   { icon: XCircle,      classes: 'text-destructive' },
  blocked: { icon: ShieldAlert,   classes: 'text-info' },
  skipped: { icon: CircleSlash,   classes: 'text-tertiary' },
}

function formatStatusCode(code: number, t: (key: string) => string): string {
  if (code === 0) return t('automations.noResponse')
  return String(code)
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// ============================================================================
// Component
// ============================================================================

export interface AutomationEventTimelineProps {
  entries: ExecutionEntry[]
  className?: string
  onReplay?: (automationId: string, event: string) => void
}

function CopyButton({ details }: { details: import('./types').WebhookDetails }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    const meta: Record<string, unknown> = {
      method: details.method,
      url: details.url,
      statusCode: details.statusCode,
      durationMs: details.durationMs,
    }
    if (details.attempts && details.attempts > 1) meta.attempts = details.attempts
    if (details.error) meta.error = details.error

    // Build copy text: structured metadata + raw response body (which may be truncated / not valid JSON)
    let text = JSON.stringify(meta, null, 2)
    if (details.responseBody) {
      text += '\n\n--- Response Body ---\n' + details.responseBody
    }

    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [details])

  const Icon = copied ? Check : Copy

  return (
    <IconButton
      size="sm"
      aria-label={t('automations.copyPayload')}
      title={t('automations.copyPayload')}
      className={cn(copied && 'text-success hover:text-success')}
      onClick={handleCopy}
      icon={<Icon className="size-3.5" />}
    />
  )
}

export function AutomationEventTimeline({ entries, className, onReplay }: AutomationEventTimelineProps) {
  const { t } = useTranslation()
  const { navigateToSession } = useNavigation()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  if (entries.length === 0) {
    return (
      <div className="px-3.5 py-6 text-center text-label text-tertiary">
        {t('automations.noActivityYet')}
      </div>
    )
  }

  return (
    <div className={cn('divide-y divide-separator', className)}>
      {entries.map((entry) => {
        const config = statusConfig[entry.status]
        const StatusIcon = config.icon
        const isWebhook = !!entry.webhookDetails
        const isExpanded = expandedId === entry.id

        const handleToggle = isWebhook ? () => setExpandedId(isExpanded ? null : entry.id) : undefined
        const handleKeyDown = isWebhook ? (e: React.KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setExpandedId(isExpanded ? null : entry.id)
          }
        } : undefined

        return (
          <div key={entry.id}>
            <div
              className={cn(
                'flex min-h-11 items-center gap-3 px-3.5 py-2 text-label',
                isWebhook && 'cursor-pointer -outline-offset-2 transition-colors duration-micro ease-out-subtle hover:bg-fill-hover hover:duration-instant',
              )}
              onClick={handleToggle}
              onKeyDown={handleKeyDown}
              role={isWebhook ? 'button' : undefined}
              tabIndex={isWebhook ? 0 : undefined}
            >
              {/* Status icon */}
              <StatusIcon className={cn('size-3.5 shrink-0', config.classes)} aria-hidden />

              {/* Time */}
              <span className="w-16 shrink-0 text-label-sm text-tertiary tabular-nums">
                {formatShortRelativeTime(entry.timestamp)}
              </span>

              {/* Action summary — truncated prompt text */}
              <span className="min-w-0 flex-1 truncate text-label-sm text-secondary">
                {entry.actionSummary || entry.error || '—'}
              </span>

              {/* Session deep link */}
              {entry.sessionId && (
                <button
                  className="shrink-0 cursor-pointer rounded-xs text-label-sm text-accent hover:underline"
                  onClick={(e) => { e.stopPropagation(); navigateToSession(entry.sessionId!) }}
                >
                  {t('automations.openSession')}
                </button>
              )}

              {/* Retry button for failed webhook entries */}
              {entry.status === 'error' && isWebhook && onReplay && (
                <button
                  className="shrink-0 cursor-pointer rounded-xs text-label-sm text-accent hover:underline"
                  onClick={(e) => { e.stopPropagation(); onReplay(entry.automationId, entry.event) }}
                >
                  {t('automations.retry')}
                </button>
              )}

              {/* Expand chevron for webhook entries */}
              {isWebhook && (
                <ChevronDown aria-hidden className={cn(
                  'size-3.5 shrink-0 text-tertiary transition-transform duration-[calc(var(--spring-snap-dur)*var(--motion-scale))] ease-[var(--spring-snap)]',
                  isExpanded && 'rotate-180',
                )} />
              )}
            </div>

            {/* Expanded webhook details */}
            {isExpanded && entry.webhookDetails && (
              <div className="relative mx-3.5 mb-3 mt-0.5 rounded-md bg-sunken px-3 py-2.5 text-label-sm inset-ring inset-ring-[var(--border-subtle)]">
                <div className="absolute top-1.5 right-1.5">
                  <CopyButton details={entry.webhookDetails} />
                </div>
                <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 pr-6 in-data-compact:pr-10">
                  <span className="text-tertiary">{t('automations.webhookMethod')}</span>
                  <span className="font-mono text-mono-ui text-secondary">{entry.webhookDetails.method}</span>

                  <span className="text-tertiary">{t('automations.webhookUrl')}</span>
                  <span className="break-all font-mono text-mono-ui text-secondary">{entry.webhookDetails.url}</span>

                  <span className="text-tertiary">{t('automations.webhookStatus')}</span>
                  <span className={cn(
                    'font-mono text-mono-ui',
                    entry.webhookDetails.statusCode >= 200 && entry.webhookDetails.statusCode < 300
                      ? 'text-success'
                      : 'text-destructive',
                  )}>
                    {formatStatusCode(entry.webhookDetails.statusCode, t)}
                  </span>

                  <span className="text-tertiary">{t('automations.webhookDuration')}</span>
                  <span className="font-mono text-mono-ui text-secondary">{formatDuration(entry.webhookDetails.durationMs)}</span>

                  {entry.webhookDetails.attempts && entry.webhookDetails.attempts > 1 && (
                    <>
                      <span className="text-tertiary">{t('automations.webhookAttempts')}</span>
                      <span className="font-mono text-mono-ui text-secondary">{entry.webhookDetails.attempts}</span>
                    </>
                  )}

                  {entry.webhookDetails.error && (
                    <>
                      <span className="text-tertiary">{t('automations.webhookError')}</span>
                      <span className="font-mono text-mono-ui text-destructive">{entry.webhookDetails.error}</span>
                    </>
                  )}
                </div>

                {entry.webhookDetails.responseBody && (
                  <div className="mt-2 border-t border-subtle pt-2">
                    <span className="text-tertiary">{t('automations.webhookResponse')}</span>
                    <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-fill-hover p-2 font-mono text-mono-ui text-secondary">
                      {entry.webhookDetails.responseBody}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
