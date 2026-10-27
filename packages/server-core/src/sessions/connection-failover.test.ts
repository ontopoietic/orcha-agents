import { describe, expect, it } from 'bun:test'
import type { LlmConnection } from '@craft-agent/shared/config'
import {
  decideLimitRecovery,
  isMigratableSession,
  limitedUntilFor,
  mergeLimitHit,
  resolveFailoverTarget,
  resolveModelForTarget,
  turnMadeProgress,
  RATE_LIMIT_RETRY_DELAY_MS,
  USAGE_LIMIT_FALLBACK_MS,
} from './connection-failover'

const conn = (slug: string, extra: Partial<LlmConnection> = {}): LlmConnection => ({
  slug, name: slug, providerType: 'anthropic', authType: 'oauth', createdAt: 0, ...extra,
})

const personal = conn('claude-max', { name: 'Claude Max Personal', failoverConnection: 'claude-max-2' })
const fluxs = conn('claude-max-2', { name: 'Claude Max Fluxs', failoverConnection: 'claude-max' })
const openai = conn('chatgpt', { providerType: 'pi' })
const NOW = 1_000_000

describe('resolveFailoverTarget', () => {
  it('returns the configured target', () => {
    expect(resolveFailoverTarget('claude-max', [personal, fluxs], new Map(), NOW)?.slug).toBe('claude-max-2')
  })

  it('returns null without a configured target', () => {
    expect(resolveFailoverTarget('claude-max', [conn('claude-max'), fluxs], new Map(), NOW)).toBeNull()
  })

  it('refuses a target on another provider type', () => {
    const src = conn('claude-max', { failoverConnection: 'chatgpt' })
    expect(resolveFailoverTarget('claude-max', [src, openai], new Map(), NOW)).toBeNull()
  })

  it('refuses a target that is limited itself', () => {
    const limited = new Map([['claude-max-2', NOW + 60_000]])
    expect(resolveFailoverTarget('claude-max', [personal, fluxs], limited, NOW)).toBeNull()
  })

  it('accepts a target whose limit has expired', () => {
    const expired = new Map([['claude-max-2', NOW - 1]])
    expect(resolveFailoverTarget('claude-max', [personal, fluxs], expired, NOW)?.slug).toBe('claude-max-2')
  })
})

describe('decideLimitRecovery', () => {
  const fresh = { rateRetried: false, failedOver: false }

  it('fails over at once on a usage limit', () => {
    const d = decideLimitRecovery({ kind: 'usage_limit', connectionSlug: 'claude-max' }, fresh, fluxs)
    expect(d).toEqual({ action: 'failover', target: fluxs })
  })

  it('retries a bare 429 once on the same account first', () => {
    const d = decideLimitRecovery({ kind: 'rate_limited', connectionSlug: 'claude-max' }, fresh, fluxs)
    expect(d).toEqual({ action: 'retry_same', delayMs: RATE_LIMIT_RETRY_DELAY_MS })
  })

  it('fails over on a second 429', () => {
    const d = decideLimitRecovery({ kind: 'rate_limited', connectionSlug: 'claude-max' }, { rateRetried: true, failedOver: false }, fluxs)
    expect(d.action).toBe('failover')
  })

  it('fails over at most once per turn', () => {
    const d = decideLimitRecovery({ kind: 'usage_limit', connectionSlug: 'claude-max-2' }, { rateRetried: false, failedOver: true }, personal)
    expect(d.action).toBe('none')
  })

  it('does nothing on a usage limit without a target', () => {
    expect(decideLimitRecovery({ kind: 'usage_limit', connectionSlug: 'claude-max' }, fresh, null).action).toBe('none')
  })
})

describe('mergeLimitHit', () => {
  it('lets a usage limit outrank an earlier 429 of the same turn', () => {
    const merged = mergeLimitHit({ kind: 'rate_limited', connectionSlug: 'a' }, { kind: 'usage_limit', connectionSlug: 'a', resetsAt: 5 })
    expect(merged).toEqual({ kind: 'usage_limit', connectionSlug: 'a', resetsAt: 5 })
  })

  it('keeps a usage limit when a 429 follows', () => {
    const merged = mergeLimitHit({ kind: 'usage_limit', connectionSlug: 'a', resetsAt: 5 }, { kind: 'rate_limited', connectionSlug: 'a' })
    expect(merged.kind).toBe('usage_limit')
  })
})

describe('limitedUntilFor', () => {
  it('uses the stated reset time', () => {
    expect(limitedUntilFor({ kind: 'usage_limit', connectionSlug: 'a', resetsAt: NOW + 5 }, NOW)).toBe(NOW + 5)
  })

  it('falls back when no reset time is known', () => {
    expect(limitedUntilFor({ kind: 'usage_limit', connectionSlug: 'a' }, NOW)).toBe(NOW + USAGE_LIMIT_FALLBACK_MS)
  })
})

describe('resolveModelForTarget', () => {
  it('keeps a model the target offers', () => {
    expect(resolveModelForTarget('claude-opus-5-5', conn('x', { models: [{ id: 'claude-opus-5-5' } as never] }))).toBe('claude-opus-5-5')
  })

  it('drops a model the target lacks', () => {
    expect(resolveModelForTarget('claude-opus-5-5', conn('x', { models: ['claude-sonnet-5-5'] }))).toBeUndefined()
  })
})

describe('turnMadeProgress', () => {
  it('is false when only the request and errors follow', () => {
    const msgs = [{ id: 'a', role: 'assistant' }, { id: 'u', role: 'user' }, { id: 'e', role: 'error' }]
    expect(turnMadeProgress(msgs, ['u'])).toBe(false)
  })

  it('is true when a tool ran after the request', () => {
    const msgs = [{ id: 'u', role: 'user' }, { id: 't', role: 'tool' }]
    expect(turnMadeProgress(msgs, ['u'])).toBe(true)
  })

  it('falls back to the last user message without request ids', () => {
    const msgs = [{ id: 'u', role: 'user' }, { id: 'x', role: 'assistant' }]
    expect(turnMadeProgress(msgs, undefined)).toBe(true)
  })
})

describe('isMigratableSession', () => {
  it('takes open sessions of the source connection', () => {
    expect(isMigratableSession({ llmConnection: 'claude-max', sessionStatus: 'in-progress' }, 'claude-max')).toBe(true)
  })

  it('skips archived, done, cancelled, hidden and foreign sessions', () => {
    expect(isMigratableSession({ llmConnection: 'claude-max', isArchived: true }, 'claude-max')).toBe(false)
    expect(isMigratableSession({ llmConnection: 'claude-max', sessionStatus: 'done' }, 'claude-max')).toBe(false)
    expect(isMigratableSession({ llmConnection: 'claude-max', sessionStatus: 'cancelled' }, 'claude-max')).toBe(false)
    expect(isMigratableSession({ llmConnection: 'claude-max', hidden: true }, 'claude-max')).toBe(false)
    expect(isMigratableSession({ llmConnection: 'claude-max-2' }, 'claude-max')).toBe(false)
  })
})
