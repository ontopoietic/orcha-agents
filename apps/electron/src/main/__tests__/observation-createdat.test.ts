import { describe, expect, it } from 'bun:test'
import {
  epochFromMessageId,
  stableObservationCreatedAt,
} from '../observation-watcher'

describe('epochFromMessageId', () => {
  it('extracts the epoch from a msg-<epoch>-<short> id', () => {
    expect(epochFromMessageId('msg-1779114745824-scap44')).toBe(1779114745824)
  })
  it('returns null for ids without an embedded epoch', () => {
    expect(epochFromMessageId('obs-mastra-3')).toBeNull()
    expect(epochFromMessageId('')).toBeNull()
    expect(epochFromMessageId(undefined)).toBeNull()
    expect(epochFromMessageId(null)).toBeNull()
  })
})

describe('stableObservationCreatedAt', () => {
  const bullet = (date: string | null, time = '') => ({ date, time })

  it('NEVER returns "now" — the bug that re-stamped old bullets every read', () => {
    // No evidence, no date → previously fell back to new Date(). Must be stable.
    const a = stableObservationCreatedAt(bullet(null), undefined)
    const b = stableObservationCreatedAt(bullet(null), undefined)
    expect(a).toBe('')
    expect(b).toBe('')
  })

  it('is deterministic across repeated reads', () => {
    const ev = { fullMessageId: 'msg-1779114745824-scap44' }
    const first = stableObservationCreatedAt(bullet('2026-05-28', '4:32'), ev)
    const second = stableObservationCreatedAt(bullet('2026-05-28', '4:32'), ev)
    expect(first).toBe(second)
  })

  it('prefers the message-epoch (real content time) over run-time', () => {
    const ev = {
      fullMessageId: 'msg-1779114745824-scap44',
      createdAt: '2026-06-03T10:00:00.000Z', // run-time, more recent
    }
    expect(stableObservationCreatedAt(bullet('2026-05-28', '4:32'), ev)).toBe(
      new Date(1779114745824).toISOString(),
    )
  })

  it('falls back to run-time when no epoch is resolvable', () => {
    const ev = { createdAt: '2026-05-28T09:04:41.815Z' }
    expect(stableObservationCreatedAt(bullet('2026-05-28', '4:32'), ev)).toBe(
      '2026-05-28T09:04:41.815Z',
    )
  })

  it('zero-pads single-digit-hour ledger times into a valid stable timestamp', () => {
    // "5:41" previously produced an invalid ISO → new Date() (now). Now stable.
    const got = stableObservationCreatedAt(bullet('2026-05-25', '5:41'), undefined)
    expect(got).toBe(new Date('2026-05-25T05:41:00').toISOString())
  })

  it('falls back to date-at-midnight when the time is unparseable', () => {
    const got = stableObservationCreatedAt(bullet('2026-05-25', 'garbage'), undefined)
    expect(got).toBe(new Date('2026-05-25T00:00:00').toISOString())
  })
})
