// ORCHA §bg-child-sessions (p9): tests for nested child-session row helpers
import { describe, it, expect } from 'bun:test'
import {
  buildChildPartition,
  buildDescendantIndex,
  emitRowWithChildren,
  findNearestVisibleAncestor,
  hasProcessingDescendant,
  type SessionListRow,
} from '../session-list-nesting'
import type { SessionMeta } from '@/atoms/sessions'

function makeSession(id: string, opts: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    workspaceId: 'ws-1',
    lastMessageAt: Date.parse('2026-07-01T10:00:00.000Z'),
    ...opts,
  } as SessionMeta
}

describe('buildChildPartition', () => {
  it('nests children under parents present in the list', () => {
    const parent = makeSession('p1')
    const childA = makeSession('c1', { parentSessionId: 'p1', lastMessageAt: 100 })
    const childB = makeSession('c2', { parentSessionId: 'p1', lastMessageAt: 200 })
    const { childrenByParent, nestedChildIds } = buildChildPartition([parent, childA, childB])

    expect(nestedChildIds).toEqual(new Set(['c1', 'c2']))
    // sorted by lastMessageAt desc
    expect(childrenByParent.get('p1')!.map(s => s.id)).toEqual(['c2', 'c1'])
  })

  it('treats children of missing parents as top-level (orphans)', () => {
    const orphan = makeSession('c1', { parentSessionId: 'gone' })
    const { childrenByParent, nestedChildIds } = buildChildPartition([orphan])
    expect(nestedChildIds.size).toBe(0)
    expect(childrenByParent.size).toBe(0)
  })

  it('ignores self-referencing parent ids', () => {
    const weird = makeSession('s1', { parentSessionId: 's1' })
    const { nestedChildIds } = buildChildPartition([weird])
    expect(nestedChildIds.size).toBe(0)
  })
})

describe('buildChildPartition — nearest visible ancestor', () => {
  const lookupFrom = (all: SessionMeta[]) => {
    const m = new Map(all.map(s => [s.id, s]))
    return (id: string) => m.get(id)
  }

  it('nests under the grandparent when the middle parent is archived (not in view)', () => {
    const root = makeSession('root')
    const mid = makeSession('mid', { parentSessionId: 'root', isArchived: true })
    const leaf = makeSession('leaf', { parentSessionId: 'mid' })
    const { childrenByParent, nestedChildIds } = buildChildPartition([root, leaf], lookupFrom([root, mid, leaf]))
    expect(nestedChildIds).toEqual(new Set(['leaf']))
    expect(childrenByParent.get('root')!.map(s => s.id)).toEqual(['leaf'])
  })

  it('without a full-map lookup, falls back to direct-parent-only nesting', () => {
    const root = makeSession('root')
    const leaf = makeSession('leaf', { parentSessionId: 'mid' })
    const { nestedChildIds } = buildChildPartition([root, leaf])
    expect(nestedChildIds.size).toBe(0)
  })

  it('4-level chain (user → conductor → orchestrator → node) nests level by level', () => {
    const user = makeSession('user')
    const conductor = makeSession('conductor', { parentSessionId: 'user' })
    const orch = makeSession('orch', { parentSessionId: 'conductor' })
    const node = makeSession('node', { parentSessionId: 'orch' })
    const all = [user, conductor, orch, node]
    const { childrenByParent, nestedChildIds } = buildChildPartition(all, lookupFrom(all))
    expect(nestedChildIds).toEqual(new Set(['conductor', 'orch', 'node']))
    expect(childrenByParent.get('user')!.map(s => s.id)).toEqual(['conductor'])
    expect(childrenByParent.get('conductor')!.map(s => s.id)).toEqual(['orch'])
    expect(childrenByParent.get('orch')!.map(s => s.id)).toEqual(['node'])

    const out: SessionListRow[] = []
    emitRowWithChildren({ item: user }, 0, childrenByParent, () => true, out, new Set())
    expect(out.map(r => [r.item.id, r.depth ?? 0])).toEqual([['user', 0], ['conductor', 1], ['orch', 2], ['node', 3]])
  })

  it('4-level chain with archived orchestrator: node nests under the conductor', () => {
    const user = makeSession('user')
    const conductor = makeSession('conductor', { parentSessionId: 'user' })
    const orch = makeSession('orch', { parentSessionId: 'conductor', isArchived: true })
    const nodes = [1, 2, 3].map(i => makeSession(`node${i}`, { parentSessionId: 'orch', lastMessageAt: i }))
    const view = [user, conductor, ...nodes]
    const { childrenByParent, nestedChildIds } = buildChildPartition(view, lookupFrom([...view, orch]))
    expect(nestedChildIds).toEqual(new Set(['conductor', 'node1', 'node2', 'node3']))
    expect(childrenByParent.get('conductor')!.map(s => s.id)).toEqual(['node3', 'node2', 'node1'])
  })

  it('whole chain archived except the leaf: leaf renders top-level', () => {
    const user = makeSession('user', { isArchived: true })
    const conductor = makeSession('conductor', { parentSessionId: 'user', isArchived: true })
    const orch = makeSession('orch', { parentSessionId: 'conductor', isArchived: true })
    const node = makeSession('node', { parentSessionId: 'orch' })
    const { childrenByParent, nestedChildIds } = buildChildPartition([node], lookupFrom([user, conductor, orch, node]))
    expect(nestedChildIds.size).toBe(0)
    expect(childrenByParent.size).toBe(0)
  })

  it('parent cycle: members render top-level instead of disappearing', () => {
    const a = makeSession('a', { parentSessionId: 'b' })
    const b = makeSession('b', { parentSessionId: 'a' })
    const all = [a, b]
    const { nestedChildIds } = buildChildPartition(all, lookupFrom(all))
    expect(nestedChildIds.size).toBe(0)
  })

  it('cycle among out-of-view ancestors terminates and leaves the item top-level', () => {
    const x = makeSession('x', { parentSessionId: 'y', isArchived: true })
    const y = makeSession('y', { parentSessionId: 'x', isArchived: true })
    const leaf = makeSession('leaf', { parentSessionId: 'x' })
    const { nestedChildIds } = buildChildPartition([leaf], lookupFrom([x, y, leaf]))
    expect(nestedChildIds.size).toBe(0)
  })

  it('a session hanging off a cycle nests under the in-view cycle member', () => {
    const a = makeSession('a', { parentSessionId: 'b' })
    const b = makeSession('b', { parentSessionId: 'a', isArchived: true })
    const c = makeSession('c', { parentSessionId: 'a' })
    const { childrenByParent, nestedChildIds } = buildChildPartition([a, c], lookupFrom([a, b, c]))
    expect(nestedChildIds).toEqual(new Set(['c']))
    expect(childrenByParent.get('a')!.map(s => s.id)).toEqual(['c'])
  })
})

describe('findNearestVisibleAncestor', () => {
  it('returns the first in-view ancestor, skipping out-of-view ones', () => {
    const all = new Map([
      ['g', makeSession('g')],
      ['p', makeSession('p', { parentSessionId: 'g' })],
      ['c', makeSession('c', { parentSessionId: 'p' })],
    ])
    const inView = new Set(['g', 'c'])
    expect(findNearestVisibleAncestor(all.get('c')!, id => inView.has(id), id => all.get(id))).toBe('g')
    expect(findNearestVisibleAncestor(all.get('g')!, id => inView.has(id), id => all.get(id))).toBeUndefined()
  })
})

describe('hasProcessingDescendant', () => {
  it('detects processing descendants at any depth, through archived intermediates', () => {
    const all = [
      makeSession('user'),
      makeSession('conductor', { parentSessionId: 'user' }),
      makeSession('orch', { parentSessionId: 'conductor', isArchived: true }),
      makeSession('node', { parentSessionId: 'orch', isProcessing: true }),
      makeSession('idle'),
    ]
    const index = buildDescendantIndex(all)
    expect(hasProcessingDescendant('user', index)).toBe(true)
    expect(hasProcessingDescendant('conductor', index)).toBe(true)
    expect(hasProcessingDescendant('orch', index)).toBe(true)
    expect(hasProcessingDescendant('node', index)).toBe(false) // self doesn't count
    expect(hasProcessingDescendant('idle', index)).toBe(false)
  })

  it('returns false when no descendant is processing', () => {
    const index = buildDescendantIndex([
      makeSession('p'),
      makeSession('c', { parentSessionId: 'p' }),
      makeSession('g', { parentSessionId: 'c' }),
    ])
    expect(hasProcessingDescendant('p', index)).toBe(false)
  })

  it('is cycle-safe', () => {
    const index = buildDescendantIndex([
      makeSession('a', { parentSessionId: 'b' }),
      makeSession('b', { parentSessionId: 'a' }),
    ])
    expect(hasProcessingDescendant('a', index)).toBe(false)
  })
})

describe('emitRowWithChildren', () => {
  const parent = makeSession('p1')
  const child = makeSession('c1', { parentSessionId: 'p1' })
  const grandchild = makeSession('g1', { parentSessionId: 'c1' })

  it('collapsed parent emits a single row with chevron metadata', () => {
    const { childrenByParent } = buildChildPartition([parent, child])
    const out: SessionListRow[] = []
    emitRowWithChildren({ item: parent }, 0, childrenByParent, () => false, out, new Set())

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ hasChildren: true, childCount: 1, isExpanded: false })
    expect(out[0].depth).toBeUndefined()
  })

  it('expanded parent emits nested child rows with increasing depth', () => {
    const { childrenByParent } = buildChildPartition([parent, child, grandchild])
    const out: SessionListRow[] = []
    emitRowWithChildren({ item: parent }, 0, childrenByParent, () => true, out, new Set())

    expect(out.map(r => r.item.id)).toEqual(['p1', 'c1', 'g1'])
    expect(out[1].depth).toBe(1)
    expect(out[2].depth).toBe(2)
    expect(out[1]).toMatchObject({ hasChildren: true, childCount: 1, isExpanded: true })
  })

  it('guards against cycles via the seen set', () => {
    const a = makeSession('a', { parentSessionId: 'b' })
    const b = makeSession('b', { parentSessionId: 'a' })
    // buildChildPartition never produces cyclic nesting; feed a cyclic map directly.
    const childrenByParent = new Map([['a', [b]], ['b', [a]]])
    const out: SessionListRow[] = []
    emitRowWithChildren({ item: a }, 0, childrenByParent, () => true, out, new Set())

    expect(out.map(r => r.item.id)).toEqual(['a', 'b'])
  })

  it('does not re-emit rows already seen (cross-group dedupe)', () => {
    const { childrenByParent } = buildChildPartition([parent, child])
    const seen = new Set<string>(['p1'])
    const out: SessionListRow[] = []
    emitRowWithChildren({ item: parent }, 0, childrenByParent, () => true, out, seen)
    expect(out).toHaveLength(0)
  })
})
