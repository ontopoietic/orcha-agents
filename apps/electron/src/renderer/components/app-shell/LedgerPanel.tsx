"use client"

import * as React from "react"
import { useAtomValue, useSetAtom } from "jotai"
import { motion, AnimatePresence } from "motion/react"
import {
  BookOpen,
  ChevronRight,
  ExternalLink,
  MessageSquare,
  GitCommit,
  FileSearch,
  RefreshCw,
  AlertTriangle,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { sessionMetaMapAtom } from "@/atoms/sessions"
import { focusedSessionIdAtom, ledgerWorkingDirAtom } from "@/atoms/panel-stack"
import { useActiveWorkspace } from "@/context/AppShellContext"
import { routes, navigate } from "@/lib/navigate"
import type { LedgerActivityEvent, LedgerSignalDelta } from "../../../shared/ledger-activity"

// ─── Types ───────────────────────────────────────────────────────────────────

interface LedgerEvent {
  id: string
  timestamp: string
  type: "signal" | "sync" | "obligation"
  source?: string
  summary: string
  signalsDelta?: LedgerSignalDelta[]
  completionStatus?: string
  syncPhase?: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const secs = Math.floor(diff / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  return `${hours}h`
}

function signalIcon(source: string) {
  switch (source) {
    case "conversation":
    case "manual":
      return MessageSquare
    case "code_observation":
      return GitCommit
    case "artifact_observation":
      return FileSearch
    default:
      return MessageSquare
  }
}

function signalIconColor(source: string): string {
  switch (source) {
    case "conversation":
    case "manual":
      return "color-mix(in oklch, var(--accent) 80%, transparent)"
    case "code_observation":
      return "color-mix(in oklch, var(--foreground) 50%, transparent)"
    case "artifact_observation":
      return "color-mix(in oklch, var(--info) 80%, transparent)"
    default:
      return "color-mix(in oklch, var(--foreground) 50%, transparent)"
  }
}

function obligationColor(status: string): string {
  switch (status) {
    case "blocked":
      return "color-mix(in oklch, var(--destructive) 90%, transparent)"
    case "incomplete":
      return "color-mix(in oklch, var(--info) 90%, transparent)"
    case "complete":
      return "color-mix(in oklch, var(--success) 80%, transparent)"
    default:
      return "color-mix(in oklch, var(--foreground) 40%, transparent)"
  }
}

function activityToEvents(event: LedgerActivityEvent): LedgerEvent[] {
  const events: LedgerEvent[] = []

  // New signals → individual event rows
  if (event.signalsDelta && event.signalsDelta.length > 0) {
    for (const s of event.signalsDelta) {
      events.push({
        id: s.id,
        timestamp: event.timestamp,
        type: "signal",
        source: s.source,
        summary: s.summary || "Signal",
        signalsDelta: [s],
      })
    }
  } else if (event.candidates > 0 || event.obligations > 0) {
    // Sync phase progress without new signals
    events.push({
      id: `sync-${event.timestamp}`,
      timestamp: event.timestamp,
      type: "sync",
      summary: `Sync · ${event.syncPhase}`,
      completionStatus: event.completionStatus,
      syncPhase: event.syncPhase,
    })
  }

  // Obligation alert if blocked/incomplete
  if (event.obligations > 0 && (event.completionStatus === "blocked" || event.completionStatus === "incomplete")) {
    events.push({
      id: `obl-${event.timestamp}`,
      timestamp: event.timestamp,
      type: "obligation",
      summary: `${event.obligations} Obligation${event.obligations > 1 ? "s" : ""} offen`,
      completionStatus: event.completionStatus,
    })
  }

  return events
}

// ─── LedgerPanel ─────────────────────────────────────────────────────────────

const MAX_EVENTS = 5
const AUTO_COLLAPSE_MS = 30_000

export function LedgerPanel() {
  const focusedSessionId = useAtomValue(focusedSessionIdAtom)
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const activeWorkspace = useActiveWorkspace()
  const setLedgerWorkingDir = useSetAtom(ledgerWorkingDirAtom)

  const sessionWorkingDir = focusedSessionId
    ? sessionMetaMap.get(focusedSessionId)?.workingDirectory ?? null
    : null
  const workingDirectory = sessionWorkingDir || null

  const [events, setEvents] = React.useState<LedgerEvent[]>([])
  const [totals, setTotals] = React.useState({ signals: 0, candidates: 0, obligations: 0 })
  const [isExpanded, setIsExpanded] = React.useState(false)
  const [hasNew, setHasNew] = React.useState(false)
  const [newCount, setNewCount] = React.useState(0)
  const autoCollapseTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  // Reset state when working directory changes
  React.useEffect(() => {
    setEvents([])
    setTotals({ signals: 0, candidates: 0, obligations: 0 })
    setHasNew(false)
    setNewCount(0)
  }, [workingDirectory])

  // Start/stop ledger watcher when working directory changes
  React.useEffect(() => {
    if (!workingDirectory || !window.electronAPI?.ledgerWatch) return

    window.electronAPI.ledgerWatch(workingDirectory).catch(() => {})

    const unsubscribe = window.electronAPI.onLedgerActivity?.((event: LedgerActivityEvent) => {
      setTotals({
        signals: event.signals,
        candidates: event.candidates,
        obligations: event.obligations,
      })

      const newEvents = activityToEvents(event)
      if (newEvents.length === 0) return

      setEvents((prev) => [...newEvents, ...prev].slice(0, MAX_EVENTS))
      setHasNew(true)
      setNewCount((n) => n + newEvents.length)

      // Auto-expand on new activity
      setIsExpanded(true)

      // Auto-collapse after inactivity
      if (autoCollapseTimer.current) clearTimeout(autoCollapseTimer.current)
      autoCollapseTimer.current = setTimeout(() => {
        setIsExpanded(false)
      }, AUTO_COLLAPSE_MS)
    })

    return () => {
      unsubscribe?.()
      window.electronAPI?.ledgerUnwatch?.().catch(() => {})
      if (autoCollapseTimer.current) clearTimeout(autoCollapseTimer.current)
    }
  }, [workingDirectory])

  // Clear "new" badge when user expands
  const handleToggle = () => {
    const next = !isExpanded
    setIsExpanded(next)
    if (next) {
      setHasNew(false)
      setNewCount(0)
    }
    if (!next && autoCollapseTimer.current) {
      clearTimeout(autoCollapseTimer.current)
    }
  }

  const hasEvents = events.length > 0
  const hasSummary = totals.signals > 0 || totals.candidates > 0 || totals.obligations > 0

  return (
    <div className="mx-2 mb-2 rounded-[6px] border border-foreground/[0.06] bg-foreground/[0.02]">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <button
        onClick={handleToggle}
        className={cn(
          "group/header w-full flex items-center gap-2 rounded-[6px] py-[5px] px-2 select-none",
          "hover:bg-foreground/[0.04] transition-colors duration-150 text-left",
        )}
      >
        <BookOpen
          className="h-3.5 w-3.5 shrink-0"
          style={{ color: "color-mix(in oklch, var(--foreground) 60%, transparent)" }}
        />
        <span className="text-[13px] font-medium text-foreground/60 flex-1">Ledger</span>

        {/* New-activity pulse dot */}
        <AnimatePresence>
          {hasNew && (
            <motion.span
              key="pulse"
              initial={{ opacity: 0, scale: 0.5 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.5 }}
              transition={{ duration: 0.2 }}
              className="relative flex h-2 w-2 shrink-0"
            >
              <span
                className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60"
                style={{ backgroundColor: "var(--accent)" }}
              />
              <span
                className="relative inline-flex rounded-full h-2 w-2"
                style={{ backgroundColor: "var(--accent)" }}
              />
            </motion.span>
          )}
        </AnimatePresence>

        {/* New count badge (collapsed only) */}
        {!isExpanded && newCount > 0 && (
          <span
            className="text-xs shrink-0"
            style={{ color: "var(--accent)" }}
          >
            {newCount} neu
          </span>
        )}

        {/* Chevron */}
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 transition-transform duration-200 text-foreground/30",
            isExpanded && "rotate-90"
          )}
        />
      </button>

      {/* ── Body ───────────────────────────────────────────────────────── */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            {!workingDirectory ? (
              <div className="py-2 px-2">
                <span className="text-xs text-foreground/25">Kein Arbeitsverzeichnis</span>
              </div>
            ) : hasEvents ? (
              <div className="pb-1">
                {events.map((event) => (
                  <EventRow key={event.id} event={event} />
                ))}
              </div>
            ) : (
              <div className="py-2 px-2">
                <span className="text-xs text-foreground/25">Warte auf Aktivität…</span>
              </div>
            )}

            {/* Summary footer */}
            {hasSummary && (
              <div className="flex items-center gap-2 border-t border-foreground/[0.04] py-1.5 px-2">
                <span className="text-xs text-foreground/30">
                  {totals.signals} Sig
                  {totals.candidates > 0 && ` · ${totals.candidates} Kand`}
                  {totals.obligations > 0 && ` · ${totals.obligations} Obl`}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); if (workingDirectory) setLedgerWorkingDir(workingDirectory); navigate(routes.view.ledger()) }}
                  className="ml-auto flex items-center gap-1 text-[11px] text-foreground/30 hover:text-foreground/60 transition-colors"
                >
                  Details
                  <ExternalLink className="h-2.5 w-2.5" />
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ─── EventRow ────────────────────────────────────────────────────────────────

function EventRow({ event }: { event: LedgerEvent }) {
  let Icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>
  let iconColor: string
  let label: string

  switch (event.type) {
    case "signal": {
      const src = event.source ?? ""
      Icon = signalIcon(src)
      iconColor = signalIconColor(src)
      label = event.summary.length > 36 ? event.summary.slice(0, 36) + "…" : event.summary
      break
    }
    case "sync":
      Icon = RefreshCw
      iconColor = "color-mix(in oklch, var(--success) 80%, transparent)"
      label = event.summary
      break
    case "obligation":
      Icon = AlertTriangle
      iconColor = obligationColor(event.completionStatus ?? "")
      label = event.summary
      break
    default:
      Icon = BookOpen
      iconColor = "color-mix(in oklch, var(--foreground) 40%, transparent)"
      label = event.summary
  }

  return (
    <div className="flex items-center gap-2 py-[3px] px-2">
      <Icon className="h-3 w-3 shrink-0" style={{ color: iconColor }} />
      <span className="text-[12px] text-foreground/55 flex-1 truncate">{label}</span>
      <span className="text-[11px] text-foreground/25 shrink-0">
        {relativeTime(event.timestamp)}
      </span>
    </div>
  )
}
