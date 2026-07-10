import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionManager, createManagedSession, type SessionCompletionEvent } from './SessionManager.ts'

// bg-child-result-feedback: a finished background child session delivers its
// result to the parent as a normal `send_agent_message`-shaped cross-session
// message (wrapped in a <background_result> tag), through the same
// `emitSessionComplete` seam TaskRunner/Conductor uses for turn completion.
// See specs/bg-child-sessions/bg-child-result-feedback.feature.

describe('bg-child-result-feedback (child-complete watcher)', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-bgresult-'))
    sm = new SessionManager()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function workspace() {
    return { id: 'ws_test', name: 'Test Workspace', rootPath: tmpRoot, createdAt: Date.now() }
  }

  function buildParent(id: string, opts?: { processing?: boolean }) {
    const managed = createManagedSession({ id, name: 'parent' }, workspace() as never, { messagesLoaded: true })
    managed.isProcessing = opts?.processing ?? false
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  function buildChild(id: string, parentId: string, opts?: {
    name?: string
    notifyParentOnComplete?: boolean
    errorMessage?: string
  }) {
    const managed = createManagedSession({ id, name: opts?.name ?? 'child task' }, workspace() as never, {
      messagesLoaded: true,
      parentSessionId: parentId,
      notifyParentOnComplete: opts?.notifyParentOnComplete ?? true,
    })
    if (opts?.errorMessage) {
      managed.messages = [
        { id: 'm1', role: 'error', content: opts.errorMessage, timestamp: Date.now() } as never,
      ]
    }
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  function spyOnSendMessage() {
    const calls: Array<{ sessionId: string; msg: string }> = []
    ;(sm as unknown as {
      sendMessage: (id: string, msg: string, ...rest: unknown[]) => Promise<void>
    }).sendMessage = async (id, msg) => {
      calls.push({ sessionId: id, msg })
    }
    return calls
  }

  async function fireChildComplete(evt: SessionCompletionEvent) {
    await (sm as unknown as { emitSessionComplete: (e: SessionCompletionEvent) => void }).emitSessionComplete(evt)
    // The watcher fires the async delivery fire-and-forget (`.catch(...)`, not
    // awaited by emitSessionComplete) — flush microtasks so the single
    // `await this.sendMessage(...)` inside notifyParentOnChildComplete settles
    // before assertions run.
    await Promise.resolve()
    await Promise.resolve()
  }

  it('bg-child-result-01a: a completed child delivers exactly one background_result with the final assistant text', async () => {
    buildParent('parent-1')
    buildChild('child-1', 'parent-1', { name: 'research-competitors' })
    const calls = spyOnSendMessage()

    await fireChildComplete({
      sessionId: 'child-1',
      workspaceId: 'ws_test',
      reason: 'complete',
      finalText: 'Here is what I found.',
    })

    expect(calls.length).toBe(1)
    expect(calls[0]!.sessionId).toBe('parent-1')
    expect(calls[0]!.msg).toContain('<background_result task="research-competitors" childSessionId="child-1" status="completed">')
    expect(calls[0]!.msg).toContain('Here is what I found.')
    expect(calls[0]!.msg).toContain('</background_result>')
  })

  it('bg-child-result-01b: a failed child delivers status="failed" with the last error text (no silent swallowing)', async () => {
    buildParent('parent-2')
    buildChild('child-2', 'parent-2', { name: 'broken-api-fetch', errorMessage: 'ECONNRESET: fetch failed' })
    const calls = spyOnSendMessage()

    await fireChildComplete({
      sessionId: 'child-2',
      workspaceId: 'ws_test',
      reason: 'error',
      finalText: undefined,
    })

    expect(calls.length).toBe(1)
    expect(calls[0]!.msg).toContain('status="failed"')
    expect(calls[0]!.msg).toContain('ECONNRESET: fetch failed')
  })

  it('bg-child-result-02: delivery to an idle parent goes through the normal sendMessage path (starts a turn immediately)', async () => {
    const parent = buildParent('parent-3', { processing: false })
    buildChild('child-3', 'parent-3')
    const calls = spyOnSendMessage()

    await fireChildComplete({ sessionId: 'child-3', workspaceId: 'ws_test', reason: 'complete', finalText: 'done' })

    expect(calls.length).toBe(1)
    expect(parent.isProcessing).toBe(false) // untouched by the notifier — sendMessage owns turn semantics
  })

  it('bg-child-result-03: delivery to a busy parent still calls sendMessage (queue/replay owned by sendMessage, not the notifier) without touching the parent\'s in-flight turn', async () => {
    const parent = buildParent('parent-4', { processing: true })
    buildChild('child-4', 'parent-4')
    const calls = spyOnSendMessage()

    await fireChildComplete({ sessionId: 'child-4', workspaceId: 'ws_test', reason: 'complete', finalText: 'done' })

    expect(calls.length).toBe(1)
    // The notifier must never flip/interrupt the parent's own processing state —
    // that stays exclusively sendMessage's job (steer/queue dispatch).
    expect(parent.isProcessing).toBe(true)
  })

  it('bg-child-result-04: exactly-once — a follow-up turn in the same child session never notifies again', async () => {
    const parent = buildParent('parent-5')
    const child = buildChild('child-5', 'parent-5', { name: 'one-shot-check' })
    const calls = spyOnSendMessage()

    await fireChildComplete({ sessionId: 'child-5', workspaceId: 'ws_test', reason: 'complete', finalText: 'first result' })
    expect(calls.length).toBe(1)
    expect(child.notifyParentOnComplete).toBe(false) // marker cleared after successful delivery

    // A follow-up turn completes in the same child session (marker not re-armed
    // by phase-1 routing unless the agent re-spawns via spawn_session).
    await fireChildComplete({ sessionId: 'child-5', workspaceId: 'ws_test', reason: 'complete', finalText: 'second result' })

    expect(calls.length).toBe(1)
    void parent
  })

  it('bg-child-result-05: an oversized result is truncated so the TOTAL body (content + pointer) stays within the 16 KB cap, naming the child session', async () => {
    buildParent('parent-6')
    buildChild('child-6', 'parent-6', { name: 'oversized-result-check' })
    const calls = spyOnSendMessage()

    const oversized = 'x'.repeat(20 * 1024)
    await fireChildComplete({ sessionId: 'child-6', workspaceId: 'ws_test', reason: 'complete', finalText: oversized })

    expect(calls.length).toBe(1)
    const msg = calls[0]!.msg
    const bodyMatch = msg.match(/status="completed">\n([\s\S]*)\n<\/background_result>/)
    expect(bodyMatch).not.toBeNull()
    const body = bodyMatch![1]!
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(16 * 1024)
    expect(body).toContain('child session child-6')
  })

  it('bg-child-result-06: delivery uses the standard sendMessage path so the parent\'s ordinary turn/observation pipeline processes it (no bypass)', async () => {
    buildParent('parent-7')
    buildChild('child-7', 'parent-7', { name: 'observation-check' })
    const calls = spyOnSendMessage()

    await fireChildComplete({ sessionId: 'child-7', workspaceId: 'ws_test', reason: 'complete', finalText: 'observed result' })

    // The notifier's only side effect is a call into the shared sendMessage
    // entrypoint — the same one send_agent_message/normal user turns use, so
    // the message flows through the ordinary turn + observation machinery
    // (covered independently by observation-trigger.test.ts and friends).
    expect(calls.length).toBe(1)
    expect(calls[0]!.sessionId).toBe('parent-7')
  })

  it('does not notify when the child has no parentSessionId', async () => {
    buildParent('parent-8')
    const child = createManagedSession({ id: 'child-8', name: 'orphan' }, workspace() as never, {
      messagesLoaded: true,
      notifyParentOnComplete: true,
    })
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set('child-8', child)
    const calls = spyOnSendMessage()

    await fireChildComplete({ sessionId: 'child-8', workspaceId: 'ws_test', reason: 'complete', finalText: 'x' })

    expect(calls).toEqual([])
  })

  it('does not notify when notifyParentOnComplete marker is not set', async () => {
    buildParent('parent-9')
    buildChild('child-9', 'parent-9', { notifyParentOnComplete: false })
    const calls = spyOnSendMessage()

    await fireChildComplete({ sessionId: 'child-9', workspaceId: 'ws_test', reason: 'complete', finalText: 'x' })

    expect(calls).toEqual([])
  })
})
