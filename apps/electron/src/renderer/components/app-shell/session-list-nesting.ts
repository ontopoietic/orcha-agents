// ORCHA §bg-child-sessions (p9): pure helpers for rendering child sessions
// (SessionMeta.parentSessionId) as nested, expandable rows under their parent
// in the session list. Kept free of React so they're unit-testable.

import type { SessionMeta } from "@/atoms/sessions"

export interface SessionListRow {
  item: SessionMeta
  /** Nesting depth (0/undefined = top-level, 1+ = nested child row) */
  depth?: number
  /** Row has nested child sessions (renders the chevron + count chip) */
  hasChildren?: boolean
  /** Number of nested child sessions under this row */
  childCount?: number
  /** Whether the child rows are currently expanded */
  isExpanded?: boolean
}

export interface ChildPartition {
  /** anchorId → nested children (sorted by lastMessageAt desc). Anchor = nearest ancestor present in `items`. */
  childrenByParent: Map<string, SessionMeta[]>
  /** ids of all items that render nested under a parent (never as top-level rows) */
  nestedChildIds: Set<string>
}

/** Lookup for session metadata by id (full meta map, incl. archived/hidden/filtered-out). */
export type SessionMetaLookup = (id: string) => SessionMeta | undefined

/**
 * Walk up the `parentSessionId` chain of `item` (resolving intermediate
 * ancestors through `lookup`, i.e. the FULL session meta map — archived,
 * hidden and filtered-out sessions included) and return the id of the nearest
 * ancestor for which `isInView(id)` is true. Returns undefined when no ancestor
 * in the chain is in the view, or when `item` itself is part of a parent cycle
 * (so a cycle can never make all of its members disappear as nested rows).
 */
export function findNearestVisibleAncestor(
  item: SessionMeta,
  isInView: (id: string) => boolean,
  lookup: SessionMetaLookup,
): string | undefined {
  const seen = new Set<string>([item.id])
  let pid = item.parentSessionId
  while (pid) {
    // Cycle reached before any in-view ancestor → treat as top-level.
    if (seen.has(pid)) return undefined
    seen.add(pid)
    if (isInView(pid)) {
      // Guard: an in-view ancestor that (transitively) points back to `item`
      // would nest both under each other. Detect by continuing the walk.
      if (chainReaches(pid, item.id, lookup)) return undefined
      return pid
    }
    pid = lookup(pid)?.parentSessionId
  }
  return undefined
}

/** True when walking up from `startId` reaches `targetId` (cycle-safe). */
function chainReaches(startId: string, targetId: string, lookup: SessionMetaLookup): boolean {
  const seen = new Set<string>()
  let cur: string | undefined = startId
  while (cur && !seen.has(cur)) {
    if (cur === targetId) return true
    seen.add(cur)
    cur = lookup(cur)?.parentSessionId
  }
  return false
}

/**
 * Partition `items` into nested children and everything else. An item nests
 * under its NEAREST ancestor that is present in `items` — intermediate
 * ancestors that are missing from the view (archived, hidden, filtered out)
 * are skipped by resolving them through `lookup` (the full session meta map).
 * Only when no ancestor of the chain is in the view does the item fall back to
 * normal top-level handling (orphan). `lookup` defaults to `items` itself
 * (direct-parent-only behaviour).
 */
export function buildChildPartition(items: SessionMeta[], lookup?: SessionMetaLookup): ChildPartition {
  const itemsById = new Map(items.map(i => [i.id, i]))
  const resolve: SessionMetaLookup = lookup ?? (id => itemsById.get(id))
  const isInView = (id: string) => itemsById.has(id)
  const childrenByParent = new Map<string, SessionMeta[]>()
  const nestedChildIds = new Set<string>()
  for (const item of items) {
    if (!item.parentSessionId) continue
    const anchorId = findNearestVisibleAncestor(item, isInView, resolve)
    if (!anchorId) continue
    const arr = childrenByParent.get(anchorId) ?? []
    arr.push(item)
    childrenByParent.set(anchorId, arr)
    nestedChildIds.add(item.id)
  }
  for (const arr of childrenByParent.values()) {
    arr.sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))
  }
  return { childrenByParent, nestedChildIds }
}

/**
 * Index of direct children by parent id over the FULL meta collection (not
 * just the current view) — input for {@link hasProcessingDescendant}.
 */
export function buildDescendantIndex(allMetas: Iterable<SessionMeta>): Map<string, SessionMeta[]> {
  const index = new Map<string, SessionMeta[]>()
  for (const meta of allMetas) {
    const pid = meta.parentSessionId
    if (!pid || pid === meta.id) continue
    const arr = index.get(pid) ?? []
    arr.push(meta)
    index.set(pid, arr)
  }
  return index
}

/**
 * True when ANY descendant of `rootId` (any depth, following parentSessionId
 * through the full meta map — including descendants whose intermediate
 * parents are archived/hidden) is currently processing. Cycle-safe.
 */
export function hasProcessingDescendant(rootId: string, childIndex: Map<string, SessionMeta[]>): boolean {
  const seen = new Set<string>([rootId])
  const stack = [rootId]
  while (stack.length > 0) {
    const id = stack.pop()!
    for (const kid of childIndex.get(id) ?? []) {
      if (seen.has(kid.id)) continue
      seen.add(kid.id)
      if (kid.isProcessing) return true
      stack.push(kid.id)
    }
  }
  return false
}

/**
 * Where a row shows descendant activity (ORCHA §session-nesting):
 * - 'chip': collapsed row with nested children → spinner on the child-count chip
 * - 'row':  row WITHOUT nested children whose running descendant has no row in
 *           the view (e.g. archived / filtered out) → the row's own spinner slot
 *           (same visual as the row's own processing state); suppressed when the
 *           row itself is processing (already spinning)
 * - 'none': nothing processing below, or the row is expanded (visible children
 *           carry their own indicators)
 */
export type RowActivityIndicator = 'none' | 'chip' | 'row'

export function getRowActivityIndicator(opts: {
  isProcessing?: boolean
  hasChildren?: boolean
  isExpanded?: boolean
  descendantProcessing: boolean
}): RowActivityIndicator {
  if (!opts.descendantProcessing) return 'none'
  if (opts.hasChildren) return opts.isExpanded ? 'none' : 'chip'
  return opts.isProcessing ? 'none' : 'row'
}

/**
 * Expand a top-level row into [parentRow, ...nestedChildRows] according to the
 * expansion state. Recursive so grandchildren nest one level deeper; `seen`
 * guards against cycles and duplicate emission across groups.
 */
export function emitRowWithChildren(
  row: SessionListRow,
  depth: number,
  childrenByParent: Map<string, SessionMeta[]>,
  isParentExpanded: (id: string) => boolean,
  out: SessionListRow[],
  seen: Set<string>,
): void {
  if (seen.has(row.item.id)) return
  seen.add(row.item.id)
  const kids = childrenByParent.get(row.item.id)
  if (!kids || kids.length === 0) {
    out.push(depth > 0 ? { ...row, depth } : row)
    return
  }
  const expanded = isParentExpanded(row.item.id)
  out.push({
    ...row,
    ...(depth > 0 ? { depth } : {}),
    hasChildren: true,
    childCount: kids.length,
    isExpanded: expanded,
  })
  if (!expanded) return
  for (const kid of kids) {
    emitRowWithChildren({ item: kid }, depth + 1, childrenByParent, isParentExpanded, out, seen)
  }
}
