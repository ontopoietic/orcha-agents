/**
 * Connection failover on Claude limits (Fork §: connection failover).
 *
 * Pure decision helpers for SessionManager: which connection a limited session moves to, whether
 * the failed turn is resent or continued, and which sessions a bulk move takes along.
 * Switching keeps the SDK session id: resume reads the local transcript, so a session continues
 * with its full history on another account of the same provider type.
 */

import type { LlmConnection } from '@craft-agent/shared/config'

/** A limit the current turn ran into. A usage limit outranks a 429 seen in the same turn. */
export interface TurnLimitHit {
  kind: 'usage_limit' | 'rate_limited'
  connectionSlug: string
  resetsAt?: number
}

/** Per-turn recovery bookkeeping (survives the recovery's own resend). */
export interface LimitRecoveryState {
  /** The 429 was already retried once on the same connection. */
  rateRetried: boolean
  /** The turn already moved to another connection once. */
  failedOver: boolean
}

export type LimitRecoveryDecision =
  | { action: 'none' }
  | { action: 'retry_same'; delayMs: number }
  | { action: 'failover'; target: LlmConnection }

/** Wait before retrying a bare 429 on the same account. */
export const RATE_LIMIT_RETRY_DELAY_MS = 10_000
/** How long an account counts as limited when the provider names no reset time. */
export const USAGE_LIMIT_FALLBACK_MS = 60 * 60_000
export const RATE_LIMIT_FALLBACK_MS = 5 * 60_000

/** Hidden nudge that resumes a turn the limit cut off after it had already done work. */
export const LIMIT_CONTINUE_PROMPT =
  'The previous response was cut off by a usage limit and the session has been moved to another account. '
  + 'Continue exactly where you left off. Do not repeat tool calls that already completed.'

export function mergeLimitHit(current: TurnLimitHit | undefined, next: TurnLimitHit): TurnLimitHit {
  if (!current) return next
  if (current.kind === 'usage_limit' && next.kind === 'rate_limited') return current
  return { ...next, resetsAt: next.resetsAt ?? current.resetsAt }
}

/** Two connections can share a session when they run on the same backend. */
export function canShareSession(from: LlmConnection, to: LlmConnection): boolean {
  return from.slug !== to.slug && from.providerType === to.providerType
}

/**
 * The connection a limited session moves to: the source's configured `failoverConnection`, if it
 * exists, runs on the same backend and is not limited itself.
 */
export function resolveFailoverTarget(
  sourceSlug: string,
  connections: LlmConnection[],
  limitedUntil: ReadonlyMap<string, number>,
  nowMs: number,
): LlmConnection | null {
  const source = connections.find(c => c.slug === sourceSlug)
  if (!source?.failoverConnection) return null
  const target = connections.find(c => c.slug === source.failoverConnection)
  if (!target || !canShareSession(source, target)) return null
  if ((limitedUntil.get(target.slug) ?? 0) > nowMs) return null
  return target
}

export function decideLimitRecovery(
  hit: TurnLimitHit,
  state: LimitRecoveryState,
  target: LlmConnection | null,
): LimitRecoveryDecision {
  if (state.failedOver) return { action: 'none' }
  if (hit.kind === 'rate_limited' && !state.rateRetried) {
    return { action: 'retry_same', delayMs: RATE_LIMIT_RETRY_DELAY_MS }
  }
  return target ? { action: 'failover', target } : { action: 'none' }
}

/** Until when the source connection counts as limited after this hit. */
export function limitedUntilFor(hit: TurnLimitHit, nowMs: number): number {
  if (hit.resetsAt && hit.resetsAt > nowMs) return hit.resetsAt
  return nowMs + (hit.kind === 'usage_limit' ? USAGE_LIMIT_FALLBACK_MS : RATE_LIMIT_FALLBACK_MS)
}

/** Keep the session's model when the target offers it; otherwise fall back to the target default. */
export function resolveModelForTarget(model: string | undefined, target: LlmConnection): string | undefined {
  if (!model) return undefined
  if (!target.models || target.models.length === 0) return model
  const ids = target.models.map(m => (typeof m === 'string' ? m : m.id))
  return ids.includes(model) ? model : undefined
}

interface ProgressMessage { id: string; role: string }

/**
 * Whether the failed turn already produced output (assistant text or tool calls) after the
 * request it was answering. Such a turn is continued, not resent, so tools never run twice.
 */
export function turnMadeProgress(messages: ProgressMessage[], requestIds: string[] | undefined): boolean {
  let start = -1
  if (requestIds && requestIds.length > 0) {
    const ids = new Set(requestIds)
    for (let i = messages.length - 1; i >= 0; i--) {
      if (ids.has(messages[i]!.id)) { start = i; break }
    }
  }
  if (start === -1) start = messages.map(m => m.role).lastIndexOf('user')
  return messages.slice(start + 1).some(m => m.role === 'assistant' || m.role === 'tool')
}

interface MigratableSession {
  llmConnection?: string
  isArchived?: boolean
  sessionStatus?: string
  hidden?: boolean
}

/** Sessions a bulk move takes along: still open work on the source connection. */
export function isMigratableSession(session: MigratableSession, fromSlug: string): boolean {
  return session.llmConnection === fromSlug
    && !session.isArchived
    && !session.hidden
    && session.sessionStatus !== 'done'
    && session.sessionStatus !== 'cancelled'
}

/** "17:50" in the user's local time, for the failover notice. */
export function formatResetTime(resetsAt: number | undefined, nowMs: number): string | undefined {
  if (!resetsAt) return undefined
  const date = new Date(resetsAt)
  const time = date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
  const sameDay = new Date(nowMs).toDateString() === date.toDateString()
  return sameDay ? time : `${date.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric' })} ${time}`
}

export function failoverNotice(fromName: string, toName: string, resetsAt: number | undefined, nowMs: number, manual: boolean): string {
  const reset = formatResetTime(resetsAt, nowMs)
  if (manual) return `Session auf ${toName} umgestellt.`
  return `Limit bei ${fromName} erreicht${reset ? ` (Reset ${reset})` : ''}. Weiter mit ${toName}.`
}
