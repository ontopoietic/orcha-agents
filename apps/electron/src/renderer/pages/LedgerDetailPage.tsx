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
  ChevronDown,
  ChevronRight,
  History,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAtomValue } from 'jotai'
import { ledgerWorkingDirAtom } from '@/atoms/panel-stack'
import {
  Info_Page,
  Info_Section,
} from '@/components/info'
import type { LedgerData, LedgerSignal, LedgerCandidate, LedgerObligation, SyncHistory, SyncHistoryRun } from '../../shared/ledger-activity'

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

type Tab = 'signals' | 'candidates' | 'obligations' | 'history'

// ─── LedgerDetailPage ────────────────────────────────────────────────────────

export default function LedgerDetailPage() {
  const workingDirectory = useAtomValue(ledgerWorkingDirAtom)

  const [data, setData] = React.useState<LedgerData | null>(null)
  const [history, setHistory] = React.useState<SyncHistory>({ version: 1, runs: [] })
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [activeTab, setActiveTab] = React.useState<Tab>('history')

  const loadData = React.useCallback(async () => {
    if (!workingDirectory) {
      setError('Kein Arbeitsverzeichnis — öffne eine Session mit Orcha-Projekt.')
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    console.log('[Ledger] loadData — workingDirectory:', workingDirectory)
    try {
      const hasHistoryApi = typeof window.electronAPI?.ledgerHistory === 'function'
      console.log('[Ledger] hasHistoryApi:', hasHistoryApi)
      const [result, hist] = await Promise.all([
        window.electronAPI.ledgerRead(workingDirectory),
        hasHistoryApi
          ? window.electronAPI.ledgerHistory(workingDirectory)
          : Promise.resolve({ version: 1 as const, runs: [] }),
      ])
      console.log('[Ledger] ledgerRead result:', result ? `${result.signals.length}S ${result.candidates.length}C ${result.obligations.length}O` : 'null')
      console.log('[Ledger] ledgerHistory result:', hist ? `${hist.runs.length} runs` : 'null/undefined')
      if (hist?.runs?.length > 0) {
        console.log('[Ledger] First run:', hist.runs[0].timestamp, hist.runs[0].commitHash, `${hist.runs[0].signals.total}S`)
      }
      setData(result ?? null)
      setHistory(hist)
      if (!hasHistoryApi) {
        console.warn('[Ledger] ledgerHistory API nicht verfügbar — Preload neu bauen?')
      }
    } catch (err) {
      console.error('[Ledger] loadData error:', err)
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
        <>
          {/* Summary bar — only when ledger is loaded */}
          {data && (
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
          )}

          {/* Tabs */}
          <div className="flex border-b border-foreground/[0.06]">
            <TabButton
              active={activeTab === 'history'}
              onClick={() => setActiveTab('history')}
              label={`Sync History (${history.runs.length})`}
            />
            {data && (
              <>
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
              </>
            )}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto">
            {activeTab === 'history' && <HistoryTab runs={history.runs} />}
            {data && activeTab === 'signals' && <SignalsTab signals={data.signals} />}
            {data && activeTab === 'candidates' && <CandidatesTab candidates={data.candidates} signals={data.signals} />}
            {data && activeTab === 'obligations' && <ObligationsTab obligations={data.obligations} />}
          </div>
        </>
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


/** Renders a signal summary with the title prefix (before first colon) in bold. */
function RenderSignalSummary({ summary }: { summary: string }) {
  const colonIdx = summary.indexOf(':')
  if (colonIdx === -1) return <>{summary}</>
  const title = summary.slice(0, colonIdx)
  const rest = summary.slice(colonIdx)
  return <><span className="font-bold text-foreground">{title}</span><span className="text-foreground/70">{rest}</span></>
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
                <div key={signal.id} className="flex items-start gap-2.5 py-1.5 px-3 rounded-md hover:bg-foreground/[0.03]">
                  <Icon className="h-3.5 w-3.5 mt-0.5 shrink-0" style={{ color: sourceColor(source) }} />
                  <div className="flex-1 min-w-0">
                    <span className="text-[13px] text-foreground/70 leading-snug block">
                      <RenderSignalSummary summary={signal.summary} />
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
            <div key={c.id} className="py-2 px-3 rounded-md hover:bg-foreground/[0.03]">
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
              <div key={o.id} className="flex items-start gap-2.5 py-1.5 px-3 rounded-md hover:bg-foreground/[0.03]">
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

// ─── History Tab ─────────────────────────────────────────────────────────────

function completionStatusColor(status: string): string {
  switch (status) {
    case 'completed':
    case 'complete': return 'bg-green-500/10 text-green-500'
    case 'in_progress': return 'bg-blue-500/10 text-blue-500'
    case 'blocked': return 'bg-red-500/10 text-red-500'
    default: return 'bg-foreground/[0.06] text-foreground/40'
  }
}

function HistoryRunRow({ run, isFirst }: { run: SyncHistoryRun; isFirst: boolean }) {
  const [expanded, setExpanded] = React.useState(isFirst)
  const ChevronIcon = expanded ? ChevronDown : ChevronRight
  const shortHash = run.commitHash ? run.commitHash.slice(0, 7) : '—'

  return (
    <div className={cn('border-b border-foreground/[0.04] last:border-0', isFirst && 'bg-foreground/[0.015]')}>
      {/* Header row */}
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-foreground/[0.03] transition-colors text-left"
      >
        <ChevronIcon className="h-3.5 w-3.5 shrink-0 text-foreground/30" />
        <History className="h-3.5 w-3.5 shrink-0 text-foreground/25" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13px] text-foreground/70 font-medium">{formatDate(run.timestamp)}</span>
            {isFirst && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent/10 text-accent">aktuell</span>
            )}
            <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full', completionStatusColor(run.completionStatus))}>
              {run.completionStatus}
            </span>
          </div>
          <div className="flex items-center gap-3 mt-0.5">
            <span className="text-[11px] text-foreground/30 font-mono">{shortHash}</span>
            {run.branch && <span className="text-[11px] text-foreground/30">{run.branch}</span>}
            <span className="text-[11px] text-foreground/25 ml-auto">
              {run.signals.total}S · {run.candidates.total}C · {run.obligations.total}O
            </span>
          </div>
        </div>
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="px-8 pb-3 space-y-3">
          {/* Signals */}
          {run.signals.total > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[11px] text-foreground/40 font-medium uppercase tracking-wide">Signale</span>
                <span className="text-[10px] text-foreground/30">{run.signals.total}</span>
              </div>
              <div className="space-y-0.5">
                {run.signals.items.slice(0, 10).map(s => {
                  const Icon = sourceIcon(s.source)
                  return (
                    <div key={s.id} className="flex items-start gap-2 py-0.5">
                      <Icon className="h-3 w-3 mt-0.5 shrink-0" style={{ color: sourceColor(s.source) }} />
                      <span className="text-[12px] text-foreground/55 leading-snug"><RenderSignalSummary summary={s.summary} /></span>
                    </div>
                  )
                })}
                {run.signals.items.length > 10 && (
                  <span className="text-[11px] text-foreground/25 pl-5">+{run.signals.items.length - 10} weitere</span>
                )}
              </div>
            </div>
          )}

          {/* Candidates */}
          {run.candidates.total > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[11px] text-foreground/40 font-medium uppercase tracking-wide">Candidates</span>
                <span className="text-[10px] text-foreground/30">{run.candidates.total}</span>
              </div>
              <div className="space-y-0.5">
                {run.candidates.items.slice(0, 8).map(c => (
                  <div key={c.id} className="flex items-center gap-2 py-0.5">
                    <span className="text-[12px] text-foreground/55"><RenderSignalSummary summary={c.title} /></span>
                    <span className="text-[10px] text-foreground/30 bg-foreground/[0.05] px-1 py-0.5 rounded">{c.category}</span>
                  </div>
                ))}
                {run.candidates.items.length > 8 && (
                  <span className="text-[11px] text-foreground/25">+{run.candidates.items.length - 8} weitere</span>
                )}
              </div>
            </div>
          )}

          {/* Obligations */}
          {run.obligations.total > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[11px] text-foreground/40 font-medium uppercase tracking-wide">Obligations</span>
                <span className="text-[10px] text-foreground/30">
                  {run.obligations.open} offen · {run.obligations.blocked} blockiert
                </span>
              </div>
              <div className="space-y-0.5">
                {run.obligations.items.slice(0, 8).map(o => {
                  const Icon = obligationStatusIcon(o.status)
                  return (
                    <div key={o.id} className="flex items-start gap-2 py-0.5">
                      <Icon className="h-3 w-3 mt-0.5 shrink-0" style={{ color: obligationStatusColor(o.status) }} />
                      <span className="text-[12px] text-foreground/55">{o.description || o.id}</span>
                    </div>
                  )
                })}
                {run.obligations.items.length > 8 && (
                  <span className="text-[11px] text-foreground/25 pl-5">+{run.obligations.items.length - 8} weitere</span>
                )}
              </div>
            </div>
          )}

          {run.signals.total === 0 && run.candidates.total === 0 && run.obligations.total === 0 && (
            <span className="text-[12px] text-foreground/25">Keine Einträge in diesem Sync.</span>
          )}
        </div>
      )}
    </div>
  )
}

function HistoryTab({ runs }: { runs: SyncHistoryRun[] }) {
  if (runs.length === 0) {
    return <EmptyState text="Noch kein Sync durchgeführt — führe `orcha sync` im Projektverzeichnis aus." />
  }

  return (
    <div className="py-2">
      <div className="px-4 pb-2">
        <span className="text-[11px] text-foreground/30">{runs.length} Sync{runs.length !== 1 ? 's' : ''} gespeichert</span>
      </div>
      <div>
        {runs.map((run, i) => (
          <HistoryRunRow key={run.id} run={run} isFirst={i === 0} />
        ))}
      </div>
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
