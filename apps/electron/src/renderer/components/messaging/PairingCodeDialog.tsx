/**
 * PairingCodeDialog — shows a 6-digit pairing code for binding a session
 * to a messaging channel. The user runs `/pair <code>` in their bot chat
 * to complete the binding.
 */

import * as React from 'react'
import { Copy, ExternalLink } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { IconButton } from '@/components/ui/button'

interface PairingCodeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  platform: 'telegram' | 'whatsapp' | 'lark'
  code: string | null
  expiresAt: number | null
  /** Bot username (without @) — enables the "Open bot" deep link. */
  botUsername?: string
  /** Error text to show in place of the code (e.g., rate limit, adapter down). */
  error?: string
}

export function PairingCodeDialog({
  open,
  onOpenChange,
  platform,
  code,
  expiresAt,
  botUsername,
  error,
}: PairingCodeDialogProps) {
  const { t } = useTranslation()
  const [secondsLeft, setSecondsLeft] = React.useState(0)

  React.useEffect(() => {
    if (!expiresAt) return
    const update = () => {
      const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
      setSecondsLeft(remaining)
    }
    update()
    const timer = setInterval(update, 1000)
    return () => clearInterval(timer)
  }, [expiresAt])

  const minutes = Math.floor(secondsLeft / 60)
  const seconds = secondsLeft % 60

  const pairCommand = code ? `/pair ${code}` : ''
  const botLink = botUsername && platform === 'telegram'
    ? `https://t.me/${botUsername}`
    : null
  const instructionsKey = `dialog.pairingCode.instructions.${platform}` as const
  const sendCommandKey = `dialog.pairingCode.sendCommand.${platform}` as const

  const handleCopy = async () => {
    if (!pairCommand) return
    try {
      await navigator.clipboard.writeText(pairCommand)
      toast.success(t('toast.copied'))
    } catch {
      toast.error(t('toast.copyFailed'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{t('dialog.pairingCode.title')}</DialogTitle>
          <DialogDescription>{t(instructionsKey)}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4 py-2">
          {error ? (
            <p className="text-label text-destructive text-center">{error}</p>
          ) : code ? (
            <>
              <div className="rounded-lg bg-sunken px-6 py-4 font-mono text-display font-semibold tracking-[0.3em] tabular-nums">
                {code}
              </div>

              <div className="flex items-center gap-1">
                <code className="rounded-sm bg-sunken px-2 py-1 text-mono-ui">{pairCommand}</code>
                <IconButton
                  size="sm"
                  aria-label={t('common.copy')}
                  tooltip
                  onClick={handleCopy}
                  icon={<Copy className="size-3.5" />}
                />
              </div>

              <p className="text-center text-label text-secondary">
                {t(sendCommandKey)}
              </p>

              {platform === 'whatsapp' && (
                <p className="text-center text-label-sm text-tertiary">
                  {t('dialog.pairingCode.whatsappSelfHint')}
                </p>
              )}

              {botLink && (
                <a
                  href={botLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-label text-accent hover:underline"
                >
                  <ExternalLink className="size-3.5" />
                  t.me/{botUsername}
                </a>
              )}

              {secondsLeft > 0 && (
                <p className="text-label-sm text-tertiary tabular-nums">
                  {t('dialog.pairingCode.expires')} ({minutes}:{seconds.toString().padStart(2, '0')})
                </p>
              )}
              {secondsLeft === 0 && expiresAt && (
                <p className="text-label-sm text-destructive">{t('dialog.pairingCode.expired')}</p>
              )}
            </>
          ) : (
            <p className="text-label text-secondary">
              {t('dialog.pairingCode.generating')}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
