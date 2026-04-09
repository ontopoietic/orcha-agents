/**
 * Ledger Watcher — Main Process
 *
 * Watches the Orcha `.orcha-ledger.json` file in the active session's working
 * directory and emits structured activity events to the renderer via IPC.
 *
 * Design: Watch the working directory (not the file itself) so we don't fail
 * when the file doesn't exist yet. Debounce 500ms to coalesce rapid writes
 * (sync runs multiple writeLedger() calls per phase).
 */

import { watch, readFileSync, existsSync } from 'fs'
import type { FSWatcher } from 'fs'
import { join } from 'path'
import type { LedgerActivityEvent, LedgerData, LedgerSignal, LedgerCandidate, LedgerObligation, LedgerSignalDelta, SyncHistory } from '../shared/ledger-activity'

export type { LedgerActivityEvent, LedgerData, SyncHistory }

const LEDGER_FILE = '.orcha-ledger.json'
const SYNC_HISTORY_FILE = '.orcha-sync-history.json'
const DEBOUNCE_MS = 500

interface PrevState {
  signals: number
  candidates: number
  obligations: number
  signalIds: Set<string>
}

let watcher: FSWatcher | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let prevState: PrevState | null = null
let currentWorkingDir: string | null = null

function readLedgerDelta(workingDir: string): LedgerActivityEvent | null {
  const ledgerPath = join(workingDir, LEDGER_FILE)
  if (!existsSync(ledgerPath)) return null

  try {
    const raw = JSON.parse(readFileSync(ledgerPath, 'utf-8'))

    const allSignals: any[] = raw.rawSignals ?? []
    const signals = allSignals.length
    const candidates = (raw.candidates ?? []).length
    const obligations = (raw.obligations ?? []).filter((o: any) => o.status === 'open').length

    // Compute new signals since last snapshot
    const signalsDelta: LedgerSignalDelta[] = []
    if (prevState !== null) {
      for (const s of allSignals) {
        if (!prevState.signalIds.has(s.id)) {
          signalsDelta.push({ id: s.id, summary: s.summary ?? '', source: s.source ?? '' })
        }
      }
    }

    const hasChanged =
      prevState === null ||
      signals !== prevState.signals ||
      candidates !== prevState.candidates ||
      obligations !== prevState.obligations

    if (!hasChanged) return null

    prevState = {
      signals,
      candidates,
      obligations,
      signalIds: new Set(allSignals.map((s: any) => s.id)),
    }

    return {
      timestamp: new Date().toISOString(),
      signals,
      signalsDelta,
      candidates,
      obligations,
      completionStatus: raw.completionStatus ?? 'unknown',
      syncPhase: raw.syncRunState?.currentPhase ?? 'unknown',
    }
  } catch {
    // JSON is being written mid-write — ignore
    return null
  }
}

/**
 * Start watching the ledger file in the given working directory.
 * Calls `onActivity` whenever the ledger changes.
 * Replaces any previously active watcher.
 */
export function startLedgerWatch(
  workingDir: string,
  onActivity: (event: LedgerActivityEvent) => void
): void {
  stopLedgerWatch()
  currentWorkingDir = workingDir

  const scheduleCheck = () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      if (!currentWorkingDir) return
      const event = readLedgerDelta(currentWorkingDir)
      if (event) onActivity(event)
    }, DEBOUNCE_MS)
  }

  try {
    // Watch the directory so we detect ledger creation too
    watcher = watch(workingDir, (_eventType, filename) => {
      if (filename === LEDGER_FILE) scheduleCheck()
    })
  } catch {
    // Silently ignore if directory doesn't exist yet
  }

  // Emit initial state on start
  const initial = readLedgerDelta(workingDir)
  if (initial) onActivity(initial)
}

/**
 * Stop the active ledger watcher and reset state.
 */
export function stopLedgerWatch(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (watcher) {
    watcher.close()
    watcher = null
  }
  prevState = null
  currentWorkingDir = null
}

/**
 * Read the sync history file for the history tab.
 */
export function readSyncHistory(workingDir: string): SyncHistory {
  const historyPath = join(workingDir, SYNC_HISTORY_FILE)
  if (!existsSync(historyPath)) return { version: 1, runs: [] }
  try {
    return JSON.parse(readFileSync(historyPath, 'utf-8')) as SyncHistory
  } catch {
    return { version: 1, runs: [] }
  }
}

/**
 * Read the full ledger contents for the detail panel.
 */
export function readFullLedger(workingDir: string): LedgerData | null {
  const ledgerPath = join(workingDir, LEDGER_FILE)
  if (!existsSync(ledgerPath)) return null

  try {
    const raw = JSON.parse(readFileSync(ledgerPath, 'utf-8'))

    const signals: LedgerSignal[] = (raw.rawSignals ?? []).map((s: any) => ({
      id: s.id,
      createdAt: s.createdAt ?? '',
      status: s.status ?? 'unknown',
      source: s.source ?? 'unknown',
      summary: s.summary ?? '',
      evidenceRefs: s.evidenceRefs,
    }))

    const candidates: LedgerCandidate[] = (raw.candidates ?? []).map((c: any) => ({
      id: c.id,
      title: c.title ?? c.summary ?? '',
      category: c.category ?? c.type ?? 'uncategorized',
      signalIds: c.signalIds ?? c.sourceSignalIds ?? [],
      createdAt: c.createdAt,
    }))

    const obligations: LedgerObligation[] = (raw.obligations ?? []).map((o: any) => ({
      id: o.id,
      status: o.status ?? 'unknown',
      description: o.description ?? o.title ?? '',
      policyRef: o.policyRef,
    }))

    return {
      signals,
      candidates,
      obligations,
      syncStatus: raw.syncRunState?.syncStatus ?? raw.syncRunState?.currentPhase ?? 'unknown',
      completionStatus: raw.completionStatus ?? 'unknown',
      updatedAt: raw.updatedAt ?? raw.sessionMeta?.updatedAt ?? '',
    }
  } catch {
    return null
  }
}
