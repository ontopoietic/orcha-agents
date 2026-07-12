/**
 * ORCHA §bg-child-sessions p7 — Stop-hook guard.
 *
 * Structural catch-all for the "silently died" incident class: an agent that
 * launches background work via a spawn path the Step-0 gate doesn't cover
 * (e.g. improvising with the `Workflow` tool instead of loading the swarm
 * skill), then ends its turn seconds later. Under streaming mode, keep-alive
 * is off (see `resolveKeepBackgroundTasksAlive`), so subprocess teardown
 * kills anything still in-query — with zero indicator to the model that it
 * happened.
 *
 * This module is the pure decision function only — no SDK types, no hook
 * plumbing. `claude-agent.ts` owns the SDK `Stop` hook wiring and the
 * per-turn `runningInQueryTaskIds` set; it calls `buildStopHookGuardDecision`
 * with a plain snapshot of that state so the branching logic is testable
 * without a live SDK query.
 */

export interface StopHookGuardInput {
  /** Count of in-query background tasks (Agent/Task/Workflow) still running this turn. */
  runningTaskCount: number;
  /** Whether streaming mode is active (keep-alive is off under streaming — see message-provider.ts). */
  streamingModeEnabled: boolean;
  /** Whether the bg-child-sessions feature (and this guard) is enabled — kill switch is ORCHA_BG_CHILD_SESSIONS=0. */
  bgChildSessionsFlagEnabled: boolean;
  /** Whether this guard has already blocked once this turn (one-shot — never traps the model in a loop). */
  alreadyFiredThisTurn: boolean;
}

export type StopHookGuardDecision =
  | { block: false }
  | { block: true; reason: string };

/**
 * Decide whether to block the Stop hook. Blocks at most once per turn: when
 * running tasks exist under streaming+flag and the guard hasn't fired yet
 * this turn. Never blocks with streaming off, the flag off, no running
 * tasks, or on a second attempt (`alreadyFiredThisTurn`).
 */
export function buildStopHookGuardDecision(input: StopHookGuardInput): StopHookGuardDecision {
  if (!input.streamingModeEnabled) return { block: false };
  if (!input.bgChildSessionsFlagEnabled) return { block: false };
  if (input.runningTaskCount <= 0) return { block: false };
  if (input.alreadyFiredThisTurn) return { block: false };

  const n = input.runningTaskCount;
  const plural = n === 1 ? '' : 's';
  return {
    block: true,
    reason:
      `You still have ${n} running in-query background task${plural} (they will NOT survive turn end in this app). ` +
      'Either wait for/drain them now (TaskOutput with block:true), stop them (TaskStop), or re-dispatch the work via ' +
      'spawn_session / the task-DAG conductor — then end your turn.',
  };
}

/**
 * Pure update step for the per-turn `runningInQueryTaskIds` set that feeds
 * `buildStopHookGuardDecision`. Mirrors exactly what `claude-agent.ts`'s
 * `chatImpl` event loop does on each adapted `AgentEvent`: add on
 * `task_backgrounded`, remove on `task_completed`, ignore everything else.
 * Mutates `ids` in place (same semantics as `Set.prototype.add`/`delete`)
 * and returns it, so call sites can use it inline.
 */
export function applyTaskLifecycleEvent(
  ids: Set<string>,
  event: { type: string; taskId?: string },
): Set<string> {
  if (event.type === 'task_backgrounded' && event.taskId) {
    ids.add(event.taskId);
  } else if (event.type === 'task_completed' && event.taskId) {
    ids.delete(event.taskId);
  }
  return ids;
}
