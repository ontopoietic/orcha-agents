// ORCHA §session-nesting: archive cascade planning
import { describe, it, expect } from 'bun:test'
import { collectDescendantIds, planArchiveCascade, planUnarchiveCascade, type CascadeNode } from './archive-cascade.ts'

describe('collectDescendantIds', () => {
  it('collects descendants at any depth, excluding the root and unrelated sessions', () => {
    const nodes: CascadeNode[] = [
      { id: 'user' },
      { id: 'conductor', parentSessionId: 'user' },
      { id: 'orch', parentSessionId: 'conductor' },
      { id: 'node1', parentSessionId: 'orch' },
      { id: 'node2', parentSessionId: 'orch' },
      { id: 'other' },
    ]
    expect(collectDescendantIds('conductor', nodes)).toEqual(['orch', 'node1', 'node2'])
    expect(collectDescendantIds('node1', nodes)).toEqual([])
  })

  it('is cycle-safe and never includes the root', () => {
    const nodes: CascadeNode[] = [
      { id: 'a', parentSessionId: 'c' },
      { id: 'b', parentSessionId: 'a' },
      { id: 'c', parentSessionId: 'b' },
      { id: 'self', parentSessionId: 'self' },
    ]
    expect(collectDescendantIds('a', nodes).sort()).toEqual(['b', 'c'])
    expect(collectDescendantIds('self', nodes)).toEqual([])
  })
})

describe('planArchiveCascade', () => {
  it('archives only not-yet-archived descendants, traversing through archived intermediates', () => {
    const nodes: CascadeNode[] = [
      { id: 'conductor' },
      { id: 'orch', parentSessionId: 'conductor', isArchived: true }, // manually archived earlier
      { id: 'node', parentSessionId: 'orch' }, // still active
      { id: 'side', parentSessionId: 'conductor' },
    ]
    expect(planArchiveCascade('conductor', nodes).sort()).toEqual(['node', 'side'])
  })

  it('archiving the orchestrator cascades to its node sessions', () => {
    const nodes: CascadeNode[] = [
      { id: 'orch', parentSessionId: 'conductor' },
      { id: 'n1', parentSessionId: 'orch' },
      { id: 'n2', parentSessionId: 'orch', isArchived: true },
    ]
    expect(planArchiveCascade('orch', nodes)).toEqual(['n1'])
  })
})

describe('planUnarchiveCascade', () => {
  it('restores only descendants cascade-archived from this root', () => {
    const nodes: CascadeNode[] = [
      { id: 'root', isArchived: false },
      { id: 'a', parentSessionId: 'root', isArchived: true, archivedByCascadeFrom: 'root' },
      { id: 'manual', parentSessionId: 'root', isArchived: true }, // manual archive
      { id: 'b', parentSessionId: 'manual', isArchived: true, archivedByCascadeFrom: 'root' },
      { id: 'other', parentSessionId: 'a', isArchived: true, archivedByCascadeFrom: 'someone-else' },
      { id: 'active', parentSessionId: 'root' },
    ]
    expect(planUnarchiveCascade('root', nodes).sort()).toEqual(['a', 'b'])
  })
})
