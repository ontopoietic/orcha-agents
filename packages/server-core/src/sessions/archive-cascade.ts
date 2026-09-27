/**
 * ORCHA §session-nesting: archive cascade over the session hierarchy
 * (`parentSessionId`). Pure planning helpers — SessionManager applies the plan
 * (persist + emit per session) so the traversal/selection rules stay
 * unit-testable.
 *
 * Rules:
 * - Archiving a session archives every descendant (any depth) that is not
 *   already archived, tagging it with `archivedByCascadeFrom = rootId`.
 *   Traversal passes THROUGH already-archived descendants (e.g. a manually
 *   archived orchestrator) so their still-active children are archived too.
 * - Unarchiving a session restores only descendants whose
 *   `archivedByCascadeFrom === rootId`; manually archived descendants (or ones
 *   archived by a different cascade root) stay archived.
 * - Cycle-safe; the root itself is never part of the descendant set.
 */

export interface CascadeNode {
  id: string
  parentSessionId?: string
  isArchived?: boolean
  archivedByCascadeFrom?: string
}

/** All descendant ids of `rootId` (any depth, BFS order), cycle-safe. */
export function collectDescendantIds(rootId: string, nodes: Iterable<CascadeNode>): string[] {
  const childrenOf = new Map<string, string[]>()
  for (const n of nodes) {
    const pid = n.parentSessionId
    if (!pid || pid === n.id) continue
    const arr = childrenOf.get(pid) ?? []
    arr.push(n.id)
    childrenOf.set(pid, arr)
  }
  const seen = new Set<string>([rootId])
  const out: string[] = []
  const queue = [rootId]
  while (queue.length > 0) {
    const id = queue.shift()!
    for (const kid of childrenOf.get(id) ?? []) {
      if (seen.has(kid)) continue
      seen.add(kid)
      out.push(kid)
      queue.push(kid)
    }
  }
  return out
}

/** Descendants to archive by cascade from `rootId` (those not yet archived). */
export function planArchiveCascade(rootId: string, nodes: CascadeNode[]): string[] {
  const byId = new Map(nodes.map(n => [n.id, n]))
  return collectDescendantIds(rootId, nodes).filter(id => byId.get(id)?.isArchived !== true)
}

/** Descendants to restore when `rootId` is unarchived (cascade-archived from it). */
export function planUnarchiveCascade(rootId: string, nodes: CascadeNode[]): string[] {
  const byId = new Map(nodes.map(n => [n.id, n]))
  return collectDescendantIds(rootId, nodes).filter(id => {
    const n = byId.get(id)
    return n?.isArchived === true && n.archivedByCascadeFrom === rootId
  })
}
