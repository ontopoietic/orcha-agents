import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionManager, createManagedSession } from './SessionManager.ts'

// Fork regression (session created with an explicit name showed "New chat"):
// an explicit name from createSession({ name }) must never be replaced by the
// first-message auto title. Unnamed sessions still get the auto title.
describe('explicit session name vs. auto title generation', () => {
  let tmpRoot: string
  let sm: SessionManager
  let events: Array<{ type: string; sessionId?: string; title?: string }>

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-explicit-name-'))
    sm = new SessionManager()
    events = []
    sm.setEventSink((_channel: string, _target: unknown, ...payload: unknown[]) => {
      events.push(payload[0] as { type: string })
    })
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildSession(id: string, name?: string) {
    const workspace = { id: 'ws_test', name: 'Test Workspace', rootPath: tmpRoot, createdAt: Date.now() }
    const managed = createManagedSession({ id, name }, workspace as never, { messagesLoaded: true })
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  async function send(sessionId: string, text: string) {
    // Continues into agent-init, which fails in this minimal harness — the
    // title decision happens before that.
    await sm.sendMessage(sessionId, text).catch(() => {})
  }

  it('keeps an explicit name on the first user message', async () => {
    const managed = buildSession('named', 'SMOKE-X')
    await send('named', 'hello world')
    expect(managed.name).toBe('SMOKE-X')
    expect(events.some(e => e.type === 'title_generated' && e.sessionId === 'named')).toBe(false)
  })

  it('still derives an initial title for unnamed sessions', async () => {
    const managed = buildSession('unnamed')
    await send('unnamed', 'hello world')
    expect(managed.name).toBe('hello world')
    expect(events.some(e => e.type === 'title_generated' && e.sessionId === 'unnamed')).toBe(true)
  })
})
