/**
 * ORCHA §bg-child-sessions — pure builders for the two `SessionEvent`s that
 * make a spawned child session visible on the parent's `ActiveTasksBar`
 * running-chip (bg-child-visibility-01).
 *
 * `onSpawnSession` already registers the child into `backgroundTaskRegistry`
 * (drives `list_background_tasks`), but never emitted `task_backgrounded` —
 * the event the renderer's chip actually listens for. `Task`/`Agent`/`Workflow`
 * launches get it via transcript signature-scanning in
 * `packages/shared/src/agent/tool-matching.ts`; `spawn_session` is a direct
 * server-side call with no matching transcript tool result, so it must be
 * emitted explicitly here instead. Extracted so the shape is unit-testable
 * without instantiating a full SessionManager (same spirit as
 * `buildChildSessionBackgroundTaskEntry`).
 */
import type { SessionEvent } from '@craft-agent/shared/protocol';

/**
 * Builds the `task_backgrounded` event for a freshly spawned child session.
 * `toolUseId` has no corresponding transcript tool message (spawn_session is
 * server-side, not scanned from tool results) — it only needs to be a stable
 * per-child key, so it's derived from the child session id.
 */
export function buildChildSessionBackgroundedEvent(
  parentSessionId: string,
  session: { id: string },
  request: { name?: string },
): SessionEvent {
  return {
    type: 'task_backgrounded',
    sessionId: parentSessionId,
    toolUseId: `spawn_session:${session.id}`,
    taskId: session.id,
    kind: 'child-session',
    ...(request.name ? { intent: request.name } : {}),
  };
}

/**
 * Builds the `task_completed` event that clears the chip once the child
 * session's terminal status has been mirrored into the parent's registry
 * (bg-child-visibility-03's existing mirroring, extended with the matching
 * event so the running chip — not just `list_background_tasks` — reflects it).
 */
export function buildChildSessionCompletedEvent(
  parentSessionId: string,
  childSessionId: string,
  status: 'completed' | 'failed',
): SessionEvent {
  return {
    type: 'task_completed',
    sessionId: parentSessionId,
    taskId: childSessionId,
    status,
  };
}
