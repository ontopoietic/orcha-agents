/**
 * Shared types for Orcha Ledger
 * Used by main/ledger-watcher.ts, renderer/LedgerPanel.tsx, renderer/LedgerDetailPage.tsx
 */

// ─── Full Ledger Types (for Detail Panel) ────────────────────────────────────

export interface LedgerSignal {
  id: string
  createdAt: string
  status: string
  source: string
  summary: string
  evidenceRefs?: string[]
}

export interface LedgerCandidate {
  id: string
  title: string
  category: string
  signalIds: string[]
  createdAt?: string
}

export interface LedgerObligation {
  id: string
  status: string
  description: string
  policyRef?: string
}

export interface LedgerData {
  signals: LedgerSignal[]
  candidates: LedgerCandidate[]
  obligations: LedgerObligation[]
  syncStatus: string
  completionStatus: string
  updatedAt: string
}

// ─── Live Activity Types (for Sidebar Watcher) ──────────────────────────────

export interface LedgerSignalDelta {
  id: string
  summary: string
  source: string
}

export interface LedgerActivityEvent {
  timestamp: string
  /** Total rawSignals in ledger */
  signals: number
  /** New signals added since last check */
  signalsDelta: LedgerSignalDelta[]
  /** Total candidates */
  candidates: number
  /** Open obligations count */
  obligations: number
  /** 'complete' | 'incomplete' | 'blocked' | 'unknown' */
  completionStatus: string
  /** 'raw' | 'classified' | 'normalized' | 'obligations' | 'complete' | 'unknown' */
  syncPhase: string
}
