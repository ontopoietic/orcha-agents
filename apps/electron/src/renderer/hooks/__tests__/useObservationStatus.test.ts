import { describe, it, expect } from 'bun:test'
import { formatRelativeTime } from '../useObservationStatus'

// Pins the time-bucket boundaries so a future refactor can't silently
// change "1m ago" to "60s ago" or drop the "d ago" branch.
describe('formatRelativeTime', () => {
  it('returns null for null input', () => {
    expect(formatRelativeTime(null)).toBeNull()
  })

  it('returns "just now" for timestamps within the last 60 seconds', () => {
    const now = new Date().toISOString()
    expect(formatRelativeTime(now)).toBe('just now')
  })

  it('returns "Xm ago" for timestamps between 1–59 minutes old', () => {
    const oneMinuteAgo = new Date(Date.now() - 90_000).toISOString()
    expect(formatRelativeTime(oneMinuteAgo)).toBe('1m ago')

    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60_000).toISOString()
    expect(formatRelativeTime(thirtyMinutesAgo)).toBe('30m ago')

    const almostOneHour = new Date(Date.now() - 59 * 60_000).toISOString()
    expect(formatRelativeTime(almostOneHour)).toBe('59m ago')
  })

  it('returns "Xh ago" for timestamps between 1–23 hours old', () => {
    const oneHourAgo = new Date(Date.now() - 61 * 60_000).toISOString()
    expect(formatRelativeTime(oneHourAgo)).toBe('1h ago')

    const twelveHoursAgo = new Date(Date.now() - 12 * 3_600_000).toISOString()
    expect(formatRelativeTime(twelveHoursAgo)).toBe('12h ago')
  })

  it('returns "Xd ago" for timestamps 24+ hours old', () => {
    const oneDayAgo = new Date(Date.now() - 25 * 3_600_000).toISOString()
    expect(formatRelativeTime(oneDayAgo)).toBe('1d ago')

    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString()
    expect(formatRelativeTime(threeDaysAgo)).toBe('3d ago')
  })
})
