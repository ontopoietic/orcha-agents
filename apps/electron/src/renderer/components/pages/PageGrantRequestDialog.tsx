import * as React from 'react'
import { KeyRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { PageGrantRequestEntry } from '../../../shared/page-bridge'
import { describeGrantAction, grantKindIcon } from './grant-visuals'

/**
 * Approval dialog for page-initiated grant requests (`grant-request` bridge
 * message). The dialog itself IS the user consent: approving calls
 * `pages:issueGrant` per entry, which binds each grant to the page's current
 * content digest. All-or-nothing per request batch — a page that wants
 * separable capabilities should send separate requests.
 */

interface PageGrantRequestDialogProps {
  pageName: string
  /** Pending request entries, or null when no dialog should show */
  requests: PageGrantRequestEntry[] | null
  busy: boolean
  onApprove: () => void
  onDeny: () => void
}

export function PageGrantRequestDialog({ pageName, requests, busy, onApprove, onDeny }: PageGrantRequestDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog open={requests !== null} onOpenChange={(open) => { if (!open && !busy) onDeny() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-info" />
            {t('pages.grants.title')}
          </DialogTitle>
          <DialogDescription>{t('pages.grants.description', { name: pageName })}</DialogDescription>
        </DialogHeader>

        <ul className="flex flex-col gap-2">
          {(requests ?? []).map((entry) => {
            const isScript = entry.action.kind === 'script'
            const Icon = grantKindIcon(entry.action.kind)
            return (
              <li
                key={entry.key}
                className={
                  isScript
                    ? 'flex items-start gap-2.5 rounded-lg border border-[color:var(--destructive-border)] bg-destructive-tint px-3 py-2.5'
                    : 'flex items-start gap-2.5 rounded-lg border border-subtle px-3 py-2.5'
                }
              >
                <Icon
                  className={isScript ? 'mt-0.5 size-4 shrink-0 text-destructive' : 'mt-0.5 size-4 shrink-0 text-tertiary'}
                />
                <div className="min-w-0 text-label">
                  <div className="break-words font-medium">{describeGrantAction(entry.action, t)}</div>
                  {isScript && (
                    <div className="mt-0.5 break-words text-label-sm font-medium text-destructive">
                      {t('pages.grants.scriptWarning')}
                    </div>
                  )}
                  {entry.description && (
                    <div className="mt-0.5 break-words text-label-sm text-secondary">{entry.description}</div>
                  )}
                </div>
              </li>
            )
          })}
        </ul>

        <p className="text-label-sm text-tertiary">{t('pages.grants.expiryNote')}</p>

        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onDeny}>
            {t('pages.grants.deny')}
          </Button>
          <Button variant="primary" disabled={busy} onClick={onApprove}>
            {busy ? t('pages.grants.approving') : t('pages.grants.approve')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
