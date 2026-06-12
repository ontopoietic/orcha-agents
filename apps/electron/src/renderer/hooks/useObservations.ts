/**
 * useObservations — React hook for reading the observations list
 *
 * Re-fetches observations.json whenever the watermark updates (which happens
 * after every observer run). Re-uses the existing observation:status IPC
 * stream — no separate file watcher needed.
 *
 * NOTE: This hook does NOT call observationWatch — it relies on a parent
 * component (e.g. SessionAnchorBar via useObservationStatus) to have started
 * the watch. If you want the hook to be self-sufficient, pass `autoWatch: true`.
 */

import { useState, useEffect, useCallback } from 'react'
import type { ObservationSignal } from '@craft-agent/shared/sessions'

export interface UseObservationsResult {
  observations: ObservationSignal[]
  loading: boolean
  refresh: () => Promise<void>
}

export function useObservations(
  sessionDir: string | null | undefined,
  options?: { autoWatch?: boolean; scope?: 'session' | 'workspace' },
): UseObservationsResult {
  const [observations, setObservations] = useState<ObservationSignal[]>([])
  const [loading, setLoading] = useState(false)
  const scope = options?.scope ?? 'session'

  const refresh = useCallback(async () => {
    if (!sessionDir) {
      setObservations([])
      return
    }
    setLoading(true)
    try {
      const list = scope === 'workspace'
        ? await window.electronAPI.observationReadWorkspaceList(sessionDir)
        : await window.electronAPI.observationReadList(sessionDir)
      setObservations(list ?? [])
    } catch {
      setObservations([])
    } finally {
      setLoading(false)
    }
  }, [sessionDir, scope])

  useEffect(() => {
    if (!sessionDir) {
      setObservations([])
      return
    }

    // Initial read
    void refresh()

    // Optionally start the watcher (otherwise rely on parent to do so)
    if (options?.autoWatch) {
      window.electronAPI.observationWatch(sessionDir).catch(() => {})
    }

    // Re-fetch whenever the watermark fires — the observer just ran
    const unsubscribe = window.electronAPI.onObservationStatus(() => {
      void refresh()
    })

    return () => {
      unsubscribe()
      if (options?.autoWatch) {
        window.electronAPI.observationUnwatch().catch(() => {})
      }
    }
  }, [sessionDir, refresh, options?.autoWatch])

  return { observations, loading, refresh }
}
