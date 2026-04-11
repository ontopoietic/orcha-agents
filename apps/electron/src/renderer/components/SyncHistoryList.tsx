import * as React from "react"
import { History, Clock, GitCommit, ChevronRight, Trash2, CheckCircle2, XCircle } from "lucide-react"
import { cn } from "@/lib/utils"

import type { SyncHistory, SyncHistoryRun } from "../../shared/ledger-activity"
import { useNavigation } from "@/contexts/NavigationContext"

function formatDate(iso: string): string {
  if (!iso) return "—"
  const d = new Date(iso)
  return d.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }) + ", " + d.toLocaleTimeString("de-DE", {
    hour: "2-digit",
    minute: "2-digit"
  })
}

function statusColor(status: string): string {
  switch (status) {
    case "completed":
    case "complete":
      return "bg-green-500/10 text-green-700 dark:bg-green-500/5"
    case "in_progress":
    case "incomplete":
      return "bg-blue-500/10 text-blue-700 dark:bg-blue-500/5"
    case "blocked":
      return "bg-red-500/10 text-red-700 dark:bg-red-500/5"
    default:
      return "bg-foreground/5 text-foreground/60"
  }
}

function StatusIcon({ status, className }: { status: string; className?: string }) {
  const Icon = (() => {
    switch (status) {
      case "completed":
      case "complete":
        return CheckCircle2
      case "in_progress":
      case "incomplete":
        return Clock
      case "blocked":
        return XCircle
      default:
        return GitCommit
    }
  })()
  return <Icon className={className} />
}

interface SyncHistoryListProps {
  runs: SyncHistoryRun[]
  onSelectRun: (runId: string) => void
  onDeleteRun?: (runId: string) => void
}

export function SyncHistoryList({ runs, onSelectRun, onDeleteRun }: SyncHistoryListProps) {
  const { navigate } = useNavigation()

  if (runs.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <p className="text-sm">Keine Sync-Historie — führe \`orcha sync\` im Projektverzeichnis aus.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 pb-3">
        <h3 className="text-base font-semibold text-foreground mb-1">
          Sync-Historie ({runs.length})
        </h3>
      </div>
      <div className="flex-1 overflow-y-auto min-w-0">
        {runs.map((run, index) => (
          <button
            key={run.id}
            onClick={() => onSelectRun(run.id)}
            className="w-full flex items-start gap-2.5 px-3 py-2 hover:bg-foreground/[0.02] transition-colors border-b border-foreground/[0.04]"
          >
            <div className="flex items-center justify-center shrink-0">
              <History className="h-4 w-4" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between min-w-0">
                <StatusIcon status={run.completionStatus} className={cn(
                  "h-4 w-4 shrink-0",
                  statusColor(run.completionStatus)
                )} />
                <div className="flex-1 min-w-0">
                  <span className={cn(
                    "text-[13px] text-foreground/70 font-medium",
                    run.completionStatus === "in_progress" ? "italic" : undefined
                  )}>
                    {run.completionStatus === "in_progress" ? "Läuft" : "Sync abgeschlossen"}
                  </span>
                </div>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-foreground/30" />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <History className="h-3.5 w-3.5 shrink-0 text-foreground/40" />
              </div>
              <div className="text-[13px] text-foreground/70">
                {formatDate(run.timestamp)}
              </div>
              <div className="flex items-center gap-2">
                <span className={cn(
                  "text-xs px-1.5 py-0.5 rounded-full",
                  statusColor(run.completionStatus)
                )}>
                  {run.completionStatus}
                </span>
                <span className="text-xs text-foreground/30 font-mono">
                  {run.branch || "—"}
                </span>
              </div>
              <div className="flex-1 min-w-0 text-foreground/40 ml-auto">
                {run.signals.total}S · {run.candidates.total}C · {run.obligations.total}O
              </div>
            </div>
            {onDeleteRun && (
              <div className="flex-1 min-w-0">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    if (window.confirm("Sync-Run wirklich löschen?")) {
                      onDeleteRun(run.id)
                    }
                  }}
                  className="p-1 text-foreground/20 hover:text-destructive hover:bg-destructive/10"
                  title="Sync-Run löschen"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}

export default SyncHistoryList
