import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionManager, createManagedSession, type SessionCompletionEvent } from './SessionManager.ts'
import { buildChildSessionBackgroundTaskEntry } from './child-session-background-task-entry.ts'
import { buildChildSessionBackgroundedEvent, buildChildSessionCompletedEvent } from './child-session-backgrounded-event.ts'

// bg-child-visibility: background child sessions are tracked in the parent's
// backgroundTaskRegistry so the existing chip UI / list_background_tasks
// report them truthfully from launch to completion (and eventual eviction).
// See specs/bg-child-sessions/bg-child-visibility.feature.

describe('bg-child-visibility-01: buildChildSessionBackgroundTaskEntry (spawn-site registry shape)', () => {
  it.each([
    ['research-competitors'],
    ['summarize-repo'],
  ])('registers a running child-session entry for task "%s"', (task) => {
    const entry = buildChildSessionBackgroundTaskEntry({ id: 'child_abc' }, { name: task }, 1000)

    expect(entry.taskId).toBe('child_abc')
    expect(entry.intent).toBe(task)
    expect(entry.status).toBe('running')
    expect(entry.kind).toBe('child-session')
    expect(entry.startTime).toBe(1000)
  })
})

describe('bg-child-visibility-01: task_backgrounded/task_completed event shapes (running-chip fix)', () => {
  it('buildChildSessionBackgroundedEvent carries kind:child-session so the renderer chip can render it', () => {
    const event = buildChildSessionBackgroundedEvent('parent-1', { id: 'child_abc' }, { name: 'research-competitors' })

    expect(event).toEqual({
      type: 'task_backgrounded',
      sessionId: 'parent-1',
      toolUseId: 'spawn_session:child_abc',
      taskId: 'child_abc',
      kind: 'child-session',
      intent: 'research-competitors',
    })
  })

  it('buildChildSessionBackgroundedEvent omits intent when the child has no name', () => {
    const event = buildChildSessionBackgroundedEvent('parent-1', { id: 'child_abc' }, {})

    expect(event).not.toHaveProperty('intent')
  })

  it('buildChildSessionCompletedEvent matches the task_backgrounded taskId so the chip can find and clear it', () => {
    const event = buildChildSessionCompletedEvent('parent-1', 'child_abc', 'completed')

    expect(event).toEqual({
      type: 'task_completed',
      sessionId: 'parent-1',
      taskId: 'child_abc',
      status: 'completed',
    })
  })
})

describe('bg-child-visibility-02/03/04: registry lifecycle in SessionManager', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-bgvisibility-'))
    sm = new SessionManager()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function workspace() {
    return { id: 'ws_test', name: 'Test Workspace', rootPath: tmpRoot, createdAt: Date.now() }
  }

  function buildParent(id: string, opts?: { keepAlive?: boolean }) {
    const managed = createManagedSession({ id, name: 'parent' }, workspace() as never, { messagesLoaded: true })
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    // markOrphanedBackgroundTasks no-ops entirely under keep-alive; default it
    // off here so the sweep under test actually runs.
    ;(sm as unknown as { keepBackgroundTasksAlive: boolean }).keepBackgroundTasksAlive = opts?.keepAlive ?? false
    return managed
  }

  function buildChild(id: string, parentId: string, name = 'child task') {
    const managed = createManagedSession({ id, name }, workspace() as never, {
      messagesLoaded: true,
      parentSessionId: parentId,
      notifyParentOnComplete: true,
    })
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  function registerChildTask(parent: { backgroundTaskRegistry: Map<string, unknown> }, taskId: string, opts?: {
    status?: string
    completedAt?: number
    kind?: 'in-query' | 'child-session'
  }) {
    parent.backgroundTaskRegistry.set(taskId, {
      taskId,
      startTime: Date.now(),
      status: opts?.status ?? 'running',
      completedAt: opts?.completedAt,
      kind: opts?.kind ?? 'child-session',
    })
  }

  it('bg-child-visibility-02: the parent turn ending does not orphan a running child-session entry, but does orphan a plain in-query one', () => {
    const parent = buildParent('parent-1')
    registerChildTask(parent, 'child-1', { kind: 'child-session' })
    registerChildTask(parent, 'inquery-1', { kind: 'in-query' })

    // markOrphanedBackgroundTasks is invoked internally as part of turn-end
    // cleanup (onProcessingStopped); call it directly, same seam pattern the
    // other phase-2/3 tests use to isolate the sweep from the rest of the
    // (heavy) turn-end pipeline.
    ;(sm as unknown as { markOrphanedBackgroundTasks: (id: string) => void }).markOrphanedBackgroundTasks('parent-1')

    const childEntry = parent.backgroundTaskRegistry.get('child-1')!
    expect(childEntry.status).toBe('running')
    expect(childEntry.completedAt).toBeUndefined()

    const inQueryEntry = parent.backgroundTaskRegistry.get('inquery-1')!
    expect(inQueryEntry.status).toBe('orphaned')
  })

  it('does not re-orphan an already-terminal entry (status !== "running" is untouched)', () => {
    const parent = buildParent('parent-1c')
    registerChildTask(parent, 'inquery-1c', { kind: 'in-query', status: 'completed', completedAt: 500 })

    ;(sm as unknown as { markOrphanedBackgroundTasks: (id: string) => void }).markOrphanedBackgroundTasks('parent-1c')

    const entry = parent.backgroundTaskRegistry.get('inquery-1c')!
    expect(entry.status).toBe('completed')
    expect(entry.completedAt).toBe(500)
  })

  it('does nothing when keepBackgroundTasksAlive is on (running entries stay running)', () => {
    const parent = buildParent('parent-1d', { keepAlive: true })
    registerChildTask(parent, 'inquery-1d', { kind: 'in-query' })

    ;(sm as unknown as { markOrphanedBackgroundTasks: (id: string) => void }).markOrphanedBackgroundTasks('parent-1d')

    expect(parent.backgroundTaskRegistry.get('inquery-1d')!.status).toBe('running')
  })

  it('is a no-op for an unknown sessionId', () => {
    ;(sm as unknown as { keepBackgroundTasksAlive: boolean }).keepBackgroundTasksAlive = false
    expect(() => (sm as unknown as { markOrphanedBackgroundTasks: (id: string) => void }).markOrphanedBackgroundTasks('does-not-exist')).not.toThrow()
  })

  it('bg-child-visibility-02b: the registry reports no "orphaned" entry for the still-running child', () => {
    const parent = buildParent('parent-1b')
    registerChildTask(parent, 'child-1b', { kind: 'child-session' })

    ;(sm as unknown as { markOrphanedBackgroundTasks: (id: string) => void }).markOrphanedBackgroundTasks('parent-1b')

    const entries = sm.listBackgroundTasks('parent-1b')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.status).toBe('running')
  })

  it('bg-child-visibility-03: child completion moves the parent registry entry to a terminal status', async () => {
    const parent = buildParent('parent-2')
    buildChild('child-2', 'parent-2', 'finishes-visibly')
    registerChildTask(parent, 'child-2', { kind: 'child-session' })
    ;(sm as unknown as {
      sendMessage: (id: string, msg: string, ...rest: unknown[]) => Promise<void>
    }).sendMessage = async () => {}

    const evt: SessionCompletionEvent = {
      sessionId: 'child-2',
      workspaceId: 'ws_test',
      reason: 'complete',
      finalText: 'done',
    }
    await (sm as unknown as { emitSessionComplete: (e: SessionCompletionEvent) => void }).emitSessionComplete(evt)
    await Promise.resolve()
    await Promise.resolve()

    const entry = parent.backgroundTaskRegistry.get('child-2')!
    expect(['completed', 'failed']).toContain(entry.status)
    expect(entry.status).not.toBe('running')
    expect(entry.completedAt).toBeGreaterThan(0)
  })

  it('bg-child-visibility-01: child completion emits task_completed so the running chip clears (not just the registry)', async () => {
    const parent = buildParent('parent-2e')
    buildChild('child-2e', 'parent-2e', 'finishes-visibly')
    registerChildTask(parent, 'child-2e', { kind: 'child-session' })
    ;(sm as unknown as {
      sendMessage: (id: string, msg: string, ...rest: unknown[]) => Promise<void>
    }).sendMessage = async () => {}
    const sentEvents: unknown[] = []
    ;(sm as unknown as {
      sendEvent: (event: unknown, workspaceId?: string) => void
    }).sendEvent = (event) => { sentEvents.push(event) }

    const evt: SessionCompletionEvent = {
      sessionId: 'child-2e',
      workspaceId: 'ws_test',
      reason: 'complete',
      finalText: 'done',
    }
    await (sm as unknown as { emitSessionComplete: (e: SessionCompletionEvent) => void }).emitSessionComplete(evt)
    await Promise.resolve()
    await Promise.resolve()

    const completedEvent = sentEvents.find(
      (e): e is { type: string; taskId: string; sessionId: string; status: string } =>
        typeof e === 'object' && e !== null && (e as { type?: string }).type === 'task_completed'
    )
    expect(completedEvent).toBeDefined()
    expect(completedEvent!.taskId).toBe('child-2e')
    expect(completedEvent!.sessionId).toBe('parent-2e')
    expect(['completed', 'failed']).toContain(completedEvent!.status)
  })

  it('bg-child-visibility-04: terminal child-session entries older than the 1h retention window are evicted', () => {
    const parent = buildParent('parent-3')
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000
    registerChildTask(parent, 'child-3', { kind: 'child-session', status: 'completed', completedAt: twoHoursAgo })

    const entries = sm.listBackgroundTasks('parent-3') // triggers lazy eviction on read
    expect(entries).toHaveLength(0)
    expect(parent.backgroundTaskRegistry.has('child-3')).toBe(false)
  })

  it('bg-child-visibility-04b: a terminal child-session entry within the retention window is kept', () => {
    const parent = buildParent('parent-4')
    const fiveMinAgo = Date.now() - 5 * 60 * 1000
    registerChildTask(parent, 'child-4', { kind: 'child-session', status: 'completed', completedAt: fiveMinAgo })

    const entries = sm.listBackgroundTasks('parent-4')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.taskId).toBe('child-4')
  })
})

// ORCHA §bg-child-sessions p6 — the production zombie-task incident: under
// streaming mode, `SessionManager.keepBackgroundTasksAlive` used to resolve
// the RAW `resolveKeepBackgroundTasksAlive()` flag (still `true` by default),
// while `ClaudeAgent` separately ANDed in `!isStreamingModeEnabled()`. The two
// call sites drifted — `markOrphanedBackgroundTasks` early-returned under
// streaming because `keepBackgroundTasksAlive` was still `true`, so
// still-running registry entries were never flipped to `orphaned` even though
// their subprocess had already torn down at turn end. Unlike the tests above
// (which override the `keepBackgroundTasksAlive` field directly to isolate
// the sweep), these tests set env BEFORE constructing `SessionManager` so the
// real `resolveKeepBackgroundTasksAlive()` resolution path — the one that
// actually broke in production — is exercised end-to-end.
describe('bg-child-sessions p6: markOrphanedBackgroundTasks resolves keep-alive honestly under streaming', () => {
  let tmpRoot: string
  const ORIGINAL_STREAMING = process.env.ORCHA_STREAMING_MODE
  const ORIGINAL_KEEP_ALIVE = process.env.CRAFT_KEEP_BG_AGENTS_ALIVE

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-bgvisibility-streaming-'))
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
    if (ORIGINAL_STREAMING === undefined) delete process.env.ORCHA_STREAMING_MODE
    else process.env.ORCHA_STREAMING_MODE = ORIGINAL_STREAMING
    if (ORIGINAL_KEEP_ALIVE === undefined) delete process.env.CRAFT_KEEP_BG_AGENTS_ALIVE
    else process.env.CRAFT_KEEP_BG_AGENTS_ALIVE = ORIGINAL_KEEP_ALIVE
  })

  function workspace() {
    return { id: 'ws_test', name: 'Test Workspace', rootPath: tmpRoot, createdAt: Date.now() }
  }

  function registerTask(parent: { backgroundTaskRegistry: Map<string, unknown> }, taskId: string, kind: 'in-query' | 'child-session') {
    parent.backgroundTaskRegistry.set(taskId, { taskId, startTime: Date.now(), status: 'running', kind })
  }

  it('streaming ON (default keep-alive flag still set): orphans the in-query entry, exempts the child-session entry', () => {
    process.env.ORCHA_STREAMING_MODE = '1'
    process.env.CRAFT_KEEP_BG_AGENTS_ALIVE = '1'
    const sm = new SessionManager()
    const managed = createManagedSession({ id: 'p6-parent-1', name: 'parent' }, workspace() as never, { messagesLoaded: true })
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set('p6-parent-1', managed)
    registerTask(managed, 'inquery-1', 'in-query')
    registerTask(managed, 'child-1', 'child-session')

    ;(sm as unknown as { markOrphanedBackgroundTasks: (id: string) => void }).markOrphanedBackgroundTasks('p6-parent-1')

    expect(managed.backgroundTaskRegistry.get('inquery-1')!.status).toBe('orphaned')
    expect(managed.backgroundTaskRegistry.get('child-1')!.status).toBe('running')
  })

  it('streaming OFF (ORCHA_STREAMING_MODE=0): upstream keep-alive suppression returns — nothing is orphaned', () => {
    process.env.ORCHA_STREAMING_MODE = '0'
    process.env.CRAFT_KEEP_BG_AGENTS_ALIVE = '1'
    const sm = new SessionManager()
    const managed = createManagedSession({ id: 'p6-parent-2', name: 'parent' }, workspace() as never, { messagesLoaded: true })
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set('p6-parent-2', managed)
    registerTask(managed, 'inquery-2', 'in-query')

    ;(sm as unknown as { markOrphanedBackgroundTasks: (id: string) => void }).markOrphanedBackgroundTasks('p6-parent-2')

    expect(managed.backgroundTaskRegistry.get('inquery-2')!.status).toBe('running')
  })
})
