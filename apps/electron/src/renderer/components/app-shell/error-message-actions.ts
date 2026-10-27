import { navigate, routes } from '@/lib/navigate'
import { dispatchFocusInputEvent } from '@/components/app-shell/input/focus-input-events'
import type { Message } from '../../../shared/types'

export type ErrorMessageAction = NonNullable<Message['errorActions']>[number]

export interface HandleErrorMessageActionOptions {
  sessionId?: string
  onOpenUrl?: (url: string) => void
  onOpenSettings?: () => void
  onRetryFocus?: (detail?: { sessionId?: string }) => void
  onRetry?: () => void
  /** Fork (connection failover): move the session to another connection and continue. */
  onSwitchConnection?: (sessionId: string, connectionSlug: string) => void
}

const switchSessionConnection = (sessionId: string, connectionSlug: string) => {
  void window.electronAPI.sessionCommand(sessionId, { type: 'failoverConnection', connectionSlug })
    .catch((error: unknown) => console.error('[failover] switching the connection failed:', error))
}

/**
 * Execute an error-message action using the app's canonical handlers.
 *
 * Retry intentionally routes through the session-scoped focus event system
 * instead of querying the DOM, which is fragile in multi-panel mode and
 * no longer matches the RichTextInput implementation.
 */
export function handleErrorMessageAction(
  action: ErrorMessageAction,
  {
    sessionId,
    onOpenUrl,
    onOpenSettings = () => navigate(routes.view.settings()),
    onRetryFocus = dispatchFocusInputEvent,
    onRetry,
    onSwitchConnection = switchSessionConnection,
  }: HandleErrorMessageActionOptions = {},
): void {
  if (action.action === 'switch_connection') {
    if (sessionId && action.connectionSlug) onSwitchConnection(sessionId, action.connectionSlug)
    return
  }

  if (action.action === 'open_url') {
    if (action.url && onOpenUrl) {
      onOpenUrl(action.url)
    }
    return
  }

  if (action.action === 'settings') {
    onOpenSettings()
    return
  }

  if (action.action === 'retry') {
    if (onRetry) {
      onRetry()
    } else {
      onRetryFocus({ sessionId })
    }
  }
}
