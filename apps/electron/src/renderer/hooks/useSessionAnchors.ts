/**
 * useSessionAnchors Hook
 *
 * Reads the current anchors of a session from the Jotai meta atom and
 * exposes mutating helpers (add/remove/replace) that round-trip through
 * the sessionCommand RPC. The renderer Jotai state updates via the
 * 'anchors_changed' event handler — this hook does not need to set state
 * itself.
 *
 * Mutations are append-and-dedupe by canonical (type, id) key so multiple
 * pickers can't double-add the same anchor.
 */

import { useCallback } from 'react'
import { useAtomValue } from 'jotai'
import type { AnchorRef } from '@craft-agent/shared/sessions/anchors'
import { anchorKey, anchorsEqual } from '@craft-agent/shared/sessions/anchors'
import { sessionMetaMapAtom } from '../atoms/sessions'

export interface UseSessionAnchorsResult {
  anchors: AnchorRef[]
  /** Add an anchor; no-op if (type,id) already present */
  add: (anchor: AnchorRef) => Promise<void>
  /** Remove an anchor by canonical key */
  remove: (anchor: Pick<AnchorRef, 'type' | 'id'>) => Promise<void>
  /** Replace the entire anchor list (used by bulk pickers) */
  replace: (anchors: AnchorRef[]) => Promise<void>
}

export function useSessionAnchors(sessionId: string | null | undefined): UseSessionAnchorsResult {
  const metaMap = useAtomValue(sessionMetaMapAtom)
  const anchors = (sessionId && metaMap.get(sessionId)?.anchors) || []

  const send = useCallback(
    async (next: AnchorRef[]) => {
      if (!sessionId) return
      await window.electronAPI.sessionCommand(sessionId, { type: 'setAnchors', anchors: next })
    },
    [sessionId],
  )

  const add = useCallback(
    async (anchor: AnchorRef) => {
      if (anchors.some((a) => anchorsEqual(a, anchor))) return
      await send([...anchors, anchor])
    },
    [anchors, send],
  )

  const remove = useCallback(
    async (target: Pick<AnchorRef, 'type' | 'id'>) => {
      const key = `${target.type}:${target.id}`
      const next = anchors.filter((a) => anchorKey(a) !== key)
      if (next.length === anchors.length) return
      await send(next)
    },
    [anchors, send],
  )

  const replace = useCallback(
    async (next: AnchorRef[]) => {
      await send(next)
    },
    [send],
  )

  return { anchors, add, remove, replace }
}
