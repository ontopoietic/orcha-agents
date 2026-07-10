/**
 * ORCHA §bg-child-sessions — pure mapping from a spawned child session to the
 * `RunningBackgroundTask` registry entry the parent tracks it under.
 *
 * Extracted out of the `onSpawnSession` closure in `SessionManager.ts` (same
 * spirit as `buildSpawnedChildSessionOptions`) so the shape asserted by
 * bg-child-visibility-01 (taskId/label/status/kind) is unit-testable without
 * instantiating a full SessionManager + agent.
 */

export interface ChildSessionBackgroundTaskEntry {
  taskId: string;
  intent?: string;
  startTime: number;
  status: 'running';
  kind: 'child-session';
}

/**
 * Builds the registry entry recorded for a freshly spawned background child
 * session (bg-child-visibility-01). `now` is injected so callers control the
 * timestamp deterministically in tests.
 */
export function buildChildSessionBackgroundTaskEntry(
  session: { id: string },
  request: { name?: string },
  now: number,
): ChildSessionBackgroundTaskEntry {
  return {
    taskId: session.id,
    intent: request.name,
    startTime: now,
    status: 'running',
    kind: 'child-session',
  };
}
