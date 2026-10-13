/**
 * WorkspaceTargetList — the pick-a-workspace list shared by the "Send to workspace" dialogs
 * (sessions and resources). Presentational only: selection and remote health live in the dialog.
 */

import { Cloud, CloudOff, Laptop } from 'lucide-react'
import { WorkspaceAvatar } from '@/components/ui/workspace-avatar'
import { cn } from '@/lib/utils'
import type { Workspace } from '../../../shared/types'

export type RemoteHealth = 'ok' | 'error' | 'checking'

interface WorkspaceTargetListProps {
  workspaces: Workspace[]
  selectedId: string | null
  onSelect: (workspaceId: string) => void
  /** Disables every row (e.g. while a transfer runs) */
  disabled?: boolean
  /** Health of remote workspaces; a remote in `error` can't be picked */
  remoteHealth: Map<string, RemoteHealth>
  iconById: Map<string, string>
  emptyLabel: string
}

export function WorkspaceTargetList({
  workspaces,
  selectedId,
  onSelect,
  disabled = false,
  remoteHealth,
  iconById,
  emptyLabel,
}: WorkspaceTargetListProps) {
  if (workspaces.length === 0) {
    return <p className="px-2 py-4 text-center text-label text-secondary">{emptyLabel}</p>
  }

  return (
    <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto py-1">
      {workspaces.map((workspace) => {
        const isRemote = !!workspace.remoteServer
        const isSelected = selectedId === workspace.id
        const health = isRemote ? remoteHealth.get(workspace.id) : undefined
        const isDisconnected = health === 'error'

        return (
          <button
            key={workspace.id}
            type="button"
            aria-pressed={isSelected}
            disabled={disabled || isDisconnected}
            onClick={() => onSelect(workspace.id)}
            className={cn(
              'flex min-h-row-list w-full items-center gap-2 rounded-md px-2 text-left text-label -outline-offset-2',
              isSelected ? 'bg-fill-selected' : 'hover:bg-fill-hover',
              isDisconnected && 'cursor-not-allowed text-disabled hover:bg-transparent',
            )}
          >
            <WorkspaceAvatar
              workspaceId={workspace.id}
              workspaceName={workspace.name}
              src={iconById.get(workspace.id)}
              className="size-5 shrink-0 rounded-full ring-1 ring-border"
              fallbackClassName="rounded-full"
            />
            <span className="flex-1 truncate">{workspace.name}</span>
            {!isRemote ? (
              <Laptop className="size-3.5 shrink-0 text-tertiary" />
            ) : isDisconnected ? (
              <CloudOff className="size-3.5 shrink-0 text-disabled" />
            ) : (
              <Cloud className={cn('size-3.5 shrink-0 text-tertiary', health === 'checking' && 'animate-pulse')} />
            )}
          </button>
        )
      })}
    </div>
  )
}
