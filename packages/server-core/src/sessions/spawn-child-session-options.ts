/**
 * ORCHA §bg-child-sessions / §session-nesting — fork additions on top of
 * upstream's `spawnedSessionOptions()` (spawn-options.ts) for children created
 * by the `spawn_session` tool. Upstream owns inheritance and the parent link;
 * this only layers the fork-specific fields over it.
 */
import type { CreateSessionOptions } from '@craft-agent/shared/protocol';

export interface OrchaSpawnRequest {
  /** Keep the child out of the session list/board; still reachable via its chip or a direct link. Always opt-in per spawn. */
  hidden?: boolean;
  /**
   * Spawn an independent top-level session instead of a nested child: no
   * `parentSessionId`, no completion `background_result` to the caller, not
   * registered as the caller's background child. Settings are still inherited.
   */
  standalone?: boolean;
}

/** Whether a spawn request links the child to its caller. */
export function isNestedSpawn(request: Pick<OrchaSpawnRequest, 'standalone'>): boolean {
  return request.standalone !== true;
}

/**
 * Overrides spread AFTER `spawnedSessionOptions()`: a nested child notifies its
 * parent on completion (bg-child-routing-03); a standalone one drops the parent
 * link. Callers must also skip the background-child registration for standalone.
 */
export function orchaSpawnOverrides(request: OrchaSpawnRequest): Partial<CreateSessionOptions> {
  return {
    ...(isNestedSpawn(request)
      ? { notifyParentOnComplete: true }
      : { parentSessionId: undefined, notifyParentOnComplete: false }),
    hidden: request.hidden ?? false,
  };
}
