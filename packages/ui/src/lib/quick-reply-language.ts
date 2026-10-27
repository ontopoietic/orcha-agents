/**
 * Response language for annotation quick-reply payloads ("Agree" / "Elaborate").
 *
 * Decoupled from the active UI language: the host app keeps this in sync with the
 * user's `responseLanguage` preference so quick-replies are written in the
 * language the agent will answer in, not the interface language.
 *
 * `undefined` means "fall back to the active UI language" (i18next default).
 */
let quickReplyLanguage: string | undefined

export function setQuickReplyLanguage(lng: string | undefined): void {
  quickReplyLanguage = lng || undefined
}

export function getQuickReplyLanguage(): string | undefined {
  return quickReplyLanguage
}
