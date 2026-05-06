/**
 * useAnchorables Hook
 *
 * Wraps the orcha-bridge IPC to load Feature/Befund/Anliegen items for
 * the anchor picker. Loads on mount + on workingDir change. Exposes a
 * refresh() that bypasses the main-process cache.
 *
 * Errors degrade to an empty list (the bridge already logs the cause);
 * callers should treat empty as "nothing pickable right now" and surface
 * a "Create new..." path in the UI.
 */

import { useState, useEffect, useCallback } from 'react'
import type { AnchorType, AnchorableItem } from '@craft-agent/shared/sessions'

export interface UseAnchorablesResult {
  items: AnchorableItem[]
  isLoading: boolean
  error: string | null
  /** Force-refresh bypassing the main-process cache */
  refresh: () => Promise<void>
}

export function useAnchorables(
  type: AnchorType,
  workingDir: string | null | undefined,
): UseAnchorablesResult {
  const [items, setItems] = useState<AnchorableItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (forceRefresh: boolean) => {
      if (!workingDir) {
        setItems([])
        setIsLoading(false)
        return
      }
      try {
        setIsLoading(true)
        setError(null)
        if (forceRefresh) {
          await window.electronAPI.clearAnchorablesCache(type, workingDir)
        }
        const result = await window.electronAPI.listAnchorables(type, workingDir)
        setItems(result)
      } catch (err) {
        console.error(`[useAnchorables] Failed to load ${type}:`, err)
        setError(err instanceof Error ? err.message : `Failed to load ${type}`)
        setItems([])
      } finally {
        setIsLoading(false)
      }
    },
    [type, workingDir],
  )

  useEffect(() => {
    load(false)
  }, [load])

  const refresh = useCallback(() => load(true), [load])

  return { items, isLoading, error, refresh }
}
