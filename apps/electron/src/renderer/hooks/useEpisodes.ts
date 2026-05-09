/**
 * useEpisodes — read-only hook over the per-session episode index.
 *
 * Phase A of memory-architecture-redesign. Subscribes to the existing
 * observation-status stream as a coarse refresh signal — episodes are
 * written by the same flow that updates the watermark, so a watermark
 * change implies the index may have changed too. Cheap read, no harm
 * if it's a no-op.
 */
import { useCallback, useEffect, useState } from 'react'
import type { EpisodeIndex, EpisodeIndexEntry } from '@craft-agent/shared/sessions'

export interface UseEpisodesResult {
  entries: EpisodeIndexEntry[]
  loading: boolean
  refresh: () => Promise<void>
}

export function useEpisodes(sessionDir: string | null | undefined): UseEpisodesResult {
  const [entries, setEntries] = useState<EpisodeIndexEntry[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!sessionDir) {
      setEntries([])
      return
    }
    setLoading(true)
    try {
      const idx: EpisodeIndex = await window.electronAPI.episodeReadIndex(sessionDir)
      setEntries(idx?.entries ?? [])
    } catch {
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [sessionDir])

  useEffect(() => {
    if (!sessionDir) {
      setEntries([])
      return
    }
    void refresh()
    const unsubscribe = window.electronAPI.onObservationStatus(() => {
      void refresh()
    })
    return () => {
      unsubscribe()
    }
  }, [sessionDir, refresh])

  return { entries, loading, refresh }
}
