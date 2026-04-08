/**
 * LedgerDetailPage
 *
 * Full-page view of the Orcha Ledger showing all signals, candidates, and obligations.
 * Accessible via the LedgerPanel sidebar or the `ledger` route.
 */

import * as React from 'react'
import {
  BookOpen,
  MessageSquare,
  GitCommit,
  FileSearch,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Clock,
  XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAtomValue } from 'jotai'
import { ledgerWorkingDirAtom } from '@/atoms/panel-stack'
import {
  Info_Page,
  Info_Section,
} from '@/components/info'
import type { LedgerData, LedgerSignal, LedgerCandidate, LedgerObligation } from '../../shared/ledger-activity'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
    + ', ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
}

function sourceIcon(source: string) {
  switch (source) {
    case 'conversation':
    case 'manual':
      return MessageSquare
    case 'code_observation':
      return GitCommit
    case 'artifact_observation':
      return FileSearch
    default:
      return MessageSquare
  }
}

function sourceLabel(source: string): string {
  switch (source) {
    case 'conversation': return 'Conversation'
    case 'manual': return 'Manuell'
    case 'code_observation': return 'Code'
    case 'artifact_observation': return 'Artefakt'
    default: return source
  }
}

function sourceColor(source: string): string {
  switch (source) {
    case 'conversation':
    case 'manual':
      return 'color-mix(in oklch, var(--accent) 80%, transparent)'
    case 'code_observation':
      return 'color-mix(in oklch, var(--foreground) 50%, transparent)'
    case 'artifact_observation':
      return 'color-mix(in oklch, var(--info) 80%, transparent)'
    default:
      return 'color-mix(in oklch, var(--foreground) 50%, transparent)'
  }
}

function obligationStatusIcon(status: string) {
  switch (status) {
    case 'complete': return CheckCircle2
    case 'open': return Clock
    case 'blocked': return XCircle
    default: return AlertTriangle
  }
}

function obligationStatusColor(status: string): string {
  switch (status) {
    case 'complete': return 'color-mix(in oklch, var(--success) 80%, transparent)'
    case 'open': return 'color-mix(in oklch, var(--info) 80%, transparent)'
    case 'blocked': return 'color-mix(in oklch, var(--destructive) 80%, transparent)'
    default: return 'color-mix(in oklch, var(--foreground) 40%, transparent)'
  }
}

type Tab = 'signals' | 'candidates' | 'obligations'

// ─── LedgerDetailPage ────────────────────────────────────────────────────────

export default function LedgerDetailPage() {
  const workingDirectory = useAtomValue(ledgerWorkingDirAtom)

  const [data, setData] = React.useState<LedgerData | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [activeTab, setActiveTab] = React.useState<Tab>('signals')

  const loadData = React.useCallback(async () => {
    if (!workingDirectory) {
      setError('Kein Arbeitsverzeichnis — öffne eine Session mit Orcha-Projekt.')
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.ledgerRead(workingDirectory)
      if (!result) {
        setError('Keine .orcha-ledger.json im Arbeitsverzeichnis gefunden.')
      } else {
        setData(result)
      }
    } catch (err) {
      setError('Fehler beim Laden des Ledger.')
    } finally {
      setLoading(false)
    }
  }, [workingDirectory])

  React.useEffect(() => { loadData() }, [loadData])

  return (
    <Info_Page loading={loading} error={error ?? undefined}>
      <Info_Page.Header
        title="Ledger"
        badge={<BookOpen className="h-4 w-4 text-foreground/40" />}
        actions={
          <button
            onClick={loadData}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-foreground/50 hover:text-foreground/80 hover:bg-foreground/[0.06] transition-colors"
          >
            <RefreshCw className="h-3 w-3" />
            Aktualisieren
          </button>
        }
      />
      <Info_Page.Content>
        {data && (
          <>
            {/* Summary bar */}
            <div className="flex items-center gap-3 px-4 py-2 border-b border-foreground/[0.06]">
              <span className="text-xs text-foreground/40">
                Status: <span className="text-foreground/60 font-medium">{data.completionStatus}</span>
              </span>
              <span className="text-xs text-foreground/40">
                Sync: <span className="text-foreground/60 font-medium">{data.syncStatus}</span>
              </span>
              {data.updatedAt && (
                <span className="text-xs text-foreground/30 ml-auto">
                  Aktualisiert: {formatDate(data.updatedAt)}
                </span>
              )}
            </div>

            {/* Tabs */}
            <div className="flex border-b border-foreground/[0.06]">
              <TabButton
                active={activeTab === 'signals'}
                onClick={() => setActiveTab('signals')}
                label={`Signale (${data.signals.length})`}
              />
              <TabButton
                active={activeTab === 'candidates'}
                onClick={() => setActiveTab('candidates')}
                label={`Candidates (${data.candidates.length})`}
              />
              <TabButton
                active={activeTab === 'obligations'}
                onClick={() => setActiveTab('obligations')}
                label={`Obligations (${data.obligations.length})`}
              />
            </div>

            {/* Tab content */}
            <div className="flex-1 overflow-y-auto">
              {activeTab === 'signals' && <SignalsTab signals={data.signals} />}
              {activeTab === 'candidates' && <CandidatesTab candidates={data.candidates} signals={data.signals} />}
              {activeTab === 'obligations' && <ObligationsTab obligations={data.obligations} />}
            </div>
          </>
        )}
      </Info_Page.Content>
    </Info_Page>
  )
}

// ─── Tab Button ──────────────────────────────────────────────────────────────

function TabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'px-4 py-2 text-xs font-medium transition-colors border-b-2 -mb-px',
        active
          ? 'text-foreground/80 border-accent'
          : 'text-foreground/40 border-transparent hover:text-foreground/60 hover:border-foreground/10'
      )}
    >
      {label}
    </button>
  )
}

// ─── Signals Tab ─────────────────────────────────────────────────────────────

function SignalsTab({ signals }: { signals: LedgerSignal[] }) {
  // Group by source
  const grouped = React.useMemo(() => {
    const groups = new Map<string, LedgerSignal[]>()
    for (const s of signals) {
      const list = groups.get(s.source) || []
      list.push(s)
      groups.set(s.source, list)
    }
    // Sort each group by createdAt desc
    for (const list of groups.values()) {
      list.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    }
    return groups
  }, [signals])

  // Source order: conversation first, then others
  const orderedSources = React.useMemo(() => {
    const sources = Array.from(grouped.keys())
    sources.sort((a, b) => {
      if (a === 'conversation') return -1
      if (b === 'conversation') return 1
      return a.localeCompare(b)
    })
    return sources
  }, [grouped])

  if (signals.length === 0) {
    return <EmptyState text="Keine Signale im Ledger." />
  }

  return (
    <div className="py-2">
      {orderedSources.map(source => {
        const items = grouped.get(source) || []
        const Icon = sourceIcon(source)
        return (
          <Info_Section key={source} title={sourceLabel(source)} actions={<span className="text-xs text-foreground/40 bg-foreground/[0.06] px-1.5 py-0.5 rounded-full">{items.length}</span>}>
            <div className="space-y-0.5">
              {items.map(signal => (
                <div key={signal.id} className="flex items-start gap-2.5 py-1.5 px-1 rounded-md hover:bg-foreground/[0.03]">
                  <Icon className="h-3.5 w-3.5 mt-0.5 shrink-0" style={{ color: sourceColor(source) }} />
                  <div className="flex-1 min-w-0">
                    <span className="text-[13px] text-foreground/70 leading-snug block">
                      {signal.summary}
                    </span>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[11px] text-foreground/30">{formatDate(signal.createdAt)}</span>
                      <span className={cn(
                        'text-[10px] px-1.5 py-0.5 rounded-full',
                        signal.status === 'classified'
                          ? 'bg-foreground/[0.06] text-foreground/40'
                          : 'bg-accent/10 text-accent'
                      )}>
                        {signal.status}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Info_Section>
        )
      })}
    </div>
  )
}

// ─── Candidates Tab ──────────────────────────────────────────────────────────

function CandidatesTab({ candidates, signals }: { candidates: LedgerCandidate[]; signals: LedgerSignal[] }) {
  const signalMap = React.useMemo(() => {
    const map = new Map<string, LedgerSignal>()
    for (const s of signals) map.set(s.id, s)
    return map
  }, [signals])

  if (candidates.length === 0) {
    return <EmptyState text="Keine Candidates im Ledger." />
  }

  return (
    <div className="py-2">
      <Info_Section title="Episodic Memory Candidates" actions={<span className="text-xs text-foreground/40 bg-foreground/[0.06] px-1.5 py-0.5 rounded-full">{candidates.length}</span>}>
        <div className="space-y-1">
          {candidates.map(c => (
            <div key={c.id} className="py-2 px-1 rounded-md hover:bg-foreground/[0.03]">
              <div className="flex items-center gap-2">
                <span className="text-[13px] text-foreground/70 font-medium">{c.title}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-foreground/[0.06] text-foreground/40">
                  {c.category}
                </span>
              </div>
              {c.signalIds.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {c.signalIds.map(sid => {
                    const signal = signalMap.get(sid)
                    return (
                      <span key={sid} className="text-[11px] text-foreground/30 truncate max-w-[200px]" title={signal?.summary}>
                        ← {signal ? signal.summary.slice(0, 40) : sid.slice(0, 8)}
                      </span>
                    )
                  })}
                </div>
              )}
              {c.createdAt && (
                <span className="text-[11px] text-foreground/25 mt-0.5 block">{formatDate(c.createdAt)}</span>
              )}
            </div>
          ))}
        </div>
      </Info_Section>
    </div>
  )
}

// ─── Obligations Tab ─────────────────────────────────────────────────────────

function ObligationsTab({ obligations }: { obligations: LedgerObligation[] }) {
  if (obligations.length === 0) {
    return <EmptyState text="Keine Obligations im Ledger." />
  }

  return (
    <div className="py-2">
      <Info_Section title="Obligations" actions={<span className="text-xs text-foreground/40 bg-foreground/[0.06] px-1.5 py-0.5 rounded-full">{obligations.length}</span>}>
        <div className="space-y-1">
          {obligations.map(o => {
            const Icon = obligationStatusIcon(o.status)
            return (
              <div key={o.id} className="flex items-start gap-2.5 py-1.5 px-1 rounded-md hover:bg-foreground/[0.03]">
                <Icon className="h-3.5 w-3.5 mt-0.5 shrink-0" style={{ color: obligationStatusColor(o.status) }} />
                <div className="flex-1 min-w-0">
                  <span className="text-[13px] text-foreground/70">{o.description || o.id}</span>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className={cn(
                      'text-[10px] px-1.5 py-0.5 rounded-full',
                      o.status === 'complete'
                        ? 'bg-green-500/10 text-green-500'
                        : o.status === 'blocked'
                          ? 'bg-red-500/10 text-red-500'
                          : 'bg-blue-500/10 text-blue-500'
                    )}>
                      {o.status}
                    </span>
                    {o.policyRef && (
                      <span className="text-[11px] text-foreground/30">→ {o.policyRef}</span>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </Info_Section>
    </div>
  )
}

// ─── Empty State ─────────────────────────────────────────────────────────────

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center py-12">
      <span className="text-sm text-foreground/25">{text}</span>
    </div>
  )
}
