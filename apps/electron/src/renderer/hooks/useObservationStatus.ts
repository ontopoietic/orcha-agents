/**
 * useObservationStatus — React hook for live observation status
 *
 * Watches the observation watermark via IPC and provides reactive state
 * for the UI badge. Starts watching when a sessionDir is provided,
 * stops on cleanup or when sessionDir changes.
 */

import { useState, useEffect, useCallback } from 'react'
import type { ObservationWatermark } from '@craft-agent/shared/sessions'

export interface ObservationStatus {
  /** Whether the observer has run at least once */
  hasObserved: boolean
  /** Total messages observed */
  observedCount: number
  /** Signals written in last run */
  lastSignalCount: number
  /** ISO timestamp of last observation */
  lastObservedAt: string | null
  /** Human-readable relative time (e.g., "2m ago") */
  relativeTime: string | null
  /** True while the orcha-observe subprocess is currently running */
  running: boolean
}

function formatRelativeTime(isoTimestamp: string | null): string | null {
  if (!isoTimestamp) return null
  const ms = Date.now() - new Date(isoTimestamp).getTime()
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

const DEFAULT_STATUS: ObservationStatus = {
  hasObserved: false,
  observedCount: 0,
  lastSignalCount: 0,
  lastObservedAt: null,
  relativeTime: null,
  running: false,
}

/**
 * Hook that provides live observation status for a session.
 * Starts an IPC file watcher on mount, stops on cleanup.
 */
export function useObservationStatus(sessionDir: string | null | undefined): ObservationStatus {
  const [status, setStatus] = useState<ObservationStatus>(DEFAULT_STATUS)

  const handleUpdate = useCallback((wm: ObservationWatermark & { running?: boolean }) => {
    const hasWatermark = !!wm.lastObservedAt
    setStatus({
      hasObserved: hasWatermark,
      observedCount: wm.observedCount ?? 0,
      lastSignalCount: wm.lastSignalCount ?? 0,
      lastObservedAt: wm.lastObservedAt || null,
      relativeTime: formatRelativeTime(wm.lastObservedAt || null),
      running: wm.running ?? false,
    })
  }, [])

  useEffect(() => {
    if (!sessionDir) {
      setStatus(DEFAULT_STATUS)
      return
    }

    // Start watching
    window.electronAPI.observationWatch(sessionDir).catch(() => {
      // Session dir may not exist yet — silently ignore
    })

    // Subscribe to updates
    const unsubscribe = window.electronAPI.onObservationStatus(handleUpdate)

    // Read initial status
    window.electronAPI.observationRead(sessionDir).then((wm) => {
      if (wm) handleUpdate(wm)
    }).catch(() => {
      // Ignore
    })

    // Refresh relative time every 30s
    const timer = setInterval(() => {
      setStatus(prev => ({
        ...prev,
        relativeTime: formatRelativeTime(prev.lastObservedAt),
      }))
    }, 30_000)

    return () => {
      unsubscribe()
      clearInterval(timer)
      window.electronAPI.observationUnwatch().catch(() => {})
    }
  }, [sessionDir, handleUpdate])

  return status
}
