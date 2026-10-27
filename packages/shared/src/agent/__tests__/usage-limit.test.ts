import { describe, expect, it } from 'bun:test'
import { isUsageLimitText, parseLimitResetTime } from '../usage-limit.ts'
import { parseError } from '../errors.ts'

// Real messages seen in Orcha sessions (2026-09/10).
const SESSION_LIMIT = "Claude Code returned an error result: You've hit your session limit · resets 5:50pm (Europe/Berlin)"
const SPEND_LIMIT = "Claude Code returned an error result: You've hit your org's monthly spend limit · ask your admin to raise it at https://claude.ai/admin-settings/usage · your weekly limit resets 9pm (Europe/Berlin)"
const THROTTLE = 'Rate Limit Exceeded: Too many requests. Please wait a moment before trying again.'

// 2026-10-27 14:00 Europe/Berlin (CET, UTC+1) = 13:00 UTC
const NOW = Date.UTC(2026, 9, 27, 13, 0)

describe('isUsageLimitText', () => {
  it('matches subscription quota messages', () => {
    expect(isUsageLimitText(SESSION_LIMIT)).toBe(true)
    expect(isUsageLimitText(SPEND_LIMIT)).toBe(true)
    expect(isUsageLimitText('Usage limit reached for Claude Max')).toBe(true)
  })

  it('does not match a plain 429 throttle', () => {
    expect(isUsageLimitText(THROTTLE)).toBe(false)
    expect(isUsageLimitText('429 Too Many Requests')).toBe(false)
  })
})

describe('parseLimitResetTime', () => {
  it('reads a same-day reset in the stated zone', () => {
    // 17:50 Berlin = 16:50 UTC
    expect(parseLimitResetTime(SESSION_LIMIT, NOW)).toBe(Date.UTC(2026, 9, 27, 16, 50))
  })

  it('reads an hour-only reset', () => {
    expect(parseLimitResetTime(SPEND_LIMIT, NOW)).toBe(Date.UTC(2026, 9, 27, 20, 0))
  })

  it('rolls a time that already passed over to tomorrow', () => {
    // 2:10am Berlin is past at 14:00 → next day 01:10 UTC
    expect(parseLimitResetTime("You've hit your session limit · resets 2:10am (Europe/Berlin)", NOW))
      .toBe(Date.UTC(2026, 9, 28, 1, 10))
  })

  it('reads a reset with a date', () => {
    expect(parseLimitResetTime("You've hit your weekly limit · resets Oct 30, 9pm (Europe/Berlin)", NOW))
      .toBe(Date.UTC(2026, 9, 30, 20, 0))
  })

  it('returns undefined without a reset time', () => {
    expect(parseLimitResetTime(THROTTLE, NOW)).toBeUndefined()
  })
})

describe('parseError usage_limit', () => {
  it('classifies quota text as usage_limit with the provider sentence and reset time', () => {
    const error = parseError(new Error(SESSION_LIMIT))
    expect(error.code).toBe('usage_limit')
    expect(error.message).toBe("You've hit your session limit · resets 5:50pm (Europe/Berlin)")
    expect(typeof error.resetsAt).toBe('number')
  })

  it('keeps 429 throttles as rate_limited', () => {
    expect(parseError(new Error('429 Too Many Requests')).code).toBe('rate_limited')
  })
})
