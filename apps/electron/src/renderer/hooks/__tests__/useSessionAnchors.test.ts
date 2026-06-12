import { describe, it, expect } from 'bun:test'
import type { AnchorRef } from '@craft-agent/shared/sessions/anchors'
import { addAnchor, removeAnchor } from '../useSessionAnchors'

function makeAnchor(type: AnchorRef['type'], id: string, extra?: Partial<AnchorRef>): AnchorRef {
  return { type, id, addedAt: '2026-01-01T00:00:00.000Z', addedBy: 'user', ...extra }
}

describe('addAnchor', () => {
  it('appends a new anchor to an empty list', () => {
    const a = makeAnchor('feature', 'f-1')
    expect(addAnchor([], a)).toEqual([a])
  })

  it('appends a new anchor to a non-empty list', () => {
    const a = makeAnchor('feature', 'f-1')
    const b = makeAnchor('befund', 'b-1')
    expect(addAnchor([a], b)).toEqual([a, b])
  })

  it('returns the same reference when the anchor is already present (dedup)', () => {
    const a = makeAnchor('feature', 'f-1')
    const duplicate = makeAnchor('feature', 'f-1', { title: 'different snapshot' })
    const list = [a]
    const result = addAnchor(list, duplicate)
    expect(result).toBe(list) // same reference — no allocation
    expect(result).toHaveLength(1)
  })

  it('dedupes across different anchor types with the same id', () => {
    const a = makeAnchor('feature', 'x-1')
    const b = makeAnchor('befund', 'x-1') // same id, different type → distinct
    const result = addAnchor([a], b)
    expect(result).toHaveLength(2)
  })
})

describe('removeAnchor', () => {
  it('removes an anchor matching (type, id)', () => {
    const a = makeAnchor('feature', 'f-1')
    const b = makeAnchor('befund', 'b-1')
    expect(removeAnchor([a, b], { type: 'feature', id: 'f-1' })).toEqual([b])
  })

  it('returns the same list when the target is not present', () => {
    const a = makeAnchor('feature', 'f-1')
    const result = removeAnchor([a], { type: 'befund', id: 'f-1' })
    expect(result).toEqual([a])
  })

  it('removes only the matching anchor when duplicates are impossible by construction', () => {
    const a = makeAnchor('anliegen', 'a-1')
    const b = makeAnchor('anliegen', 'a-2')
    expect(removeAnchor([a, b], { type: 'anliegen', id: 'a-1' })).toEqual([b])
  })

  it('returns an empty list when the only anchor is removed', () => {
    const a = makeAnchor('feature', 'f-1')
    expect(removeAnchor([a], { type: 'feature', id: 'f-1' })).toEqual([])
  })
})
