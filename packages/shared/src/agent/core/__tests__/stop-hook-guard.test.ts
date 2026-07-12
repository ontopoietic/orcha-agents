/**
 * Unit tests for the pure Stop-hook guard decision function
 * (ORCHA §bg-child-sessions p7). `claude-agent.ts` wires this into the SDK's
 * `Stop` hook and maintains the `runningInQueryTaskIds` set / one-shot flag
 * this input models — that plumbing needs a live SDK query to exercise, so
 * this file covers the branching logic directly instead.
 */
import { describe, it, expect } from 'bun:test';
import { buildStopHookGuardDecision, applyTaskLifecycleEvent } from '../stop-hook-guard.ts';

function baseInput(overrides?: Partial<Parameters<typeof buildStopHookGuardDecision>[0]>) {
  return {
    runningTaskCount: 1,
    streamingModeEnabled: true,
    bgChildSessionsFlagEnabled: true,
    alreadyFiredThisTurn: false,
    ...overrides,
  };
}

describe('buildStopHookGuardDecision', () => {
  it('blocks once when tasks are running under streaming+flag', () => {
    const decision = buildStopHookGuardDecision(baseInput({ runningTaskCount: 2 }));
    expect(decision.block).toBe(true);
    if (!decision.block) return;
    expect(decision.reason).toContain('2 running in-query background tasks');
    expect(decision.reason).toContain('will NOT survive turn end');
    expect(decision.reason).toContain('TaskOutput');
    expect(decision.reason).toContain('TaskStop');
    expect(decision.reason).toContain('spawn_session');
  });

  it('uses singular phrasing for exactly one running task', () => {
    const decision = buildStopHookGuardDecision(baseInput({ runningTaskCount: 1 }));
    expect(decision.block).toBe(true);
    if (!decision.block) return;
    expect(decision.reason).toContain('1 running in-query background task ');
    expect(decision.reason).not.toContain('tasks (');
  });

  it('allows the second attempt through even with tasks still running (one-shot)', () => {
    const decision = buildStopHookGuardDecision(baseInput({ alreadyFiredThisTurn: true }));
    expect(decision.block).toBe(false);
  });

  it('never blocks when streaming mode is off', () => {
    const decision = buildStopHookGuardDecision(baseInput({ streamingModeEnabled: false }));
    expect(decision.block).toBe(false);
  });

  it('never blocks when the bg-child-sessions flag is off', () => {
    const decision = buildStopHookGuardDecision(baseInput({ bgChildSessionsFlagEnabled: false }));
    expect(decision.block).toBe(false);
  });

  it('never blocks when there are no running tasks', () => {
    const decision = buildStopHookGuardDecision(baseInput({ runningTaskCount: 0 }));
    expect(decision.block).toBe(false);
  });
});

describe('applyTaskLifecycleEvent', () => {
  it('adds the task id on task_backgrounded', () => {
    const ids = new Set<string>();
    applyTaskLifecycleEvent(ids, { type: 'task_backgrounded', taskId: 'agent-1' });
    expect(ids.has('agent-1')).toBe(true);
  });

  it('removes the task id on task_completed', () => {
    const ids = new Set<string>(['agent-1', 'agent-2']);
    applyTaskLifecycleEvent(ids, { type: 'task_completed', taskId: 'agent-1' });
    expect(ids.has('agent-1')).toBe(false);
    expect(ids.has('agent-2')).toBe(true);
  });

  it('ignores unrelated event types', () => {
    const ids = new Set<string>(['agent-1']);
    applyTaskLifecycleEvent(ids, { type: 'tool_start', taskId: 'agent-2' });
    expect(ids.size).toBe(1);
    expect(ids.has('agent-1')).toBe(true);
  });

  it('is a no-op when taskId is missing', () => {
    const ids = new Set<string>();
    applyTaskLifecycleEvent(ids, { type: 'task_backgrounded' });
    expect(ids.size).toBe(0);
  });

  it('returns the same set instance it mutated', () => {
    const ids = new Set<string>();
    const result = applyTaskLifecycleEvent(ids, { type: 'task_backgrounded', taskId: 'agent-1' });
    expect(result).toBe(ids);
  });
});
