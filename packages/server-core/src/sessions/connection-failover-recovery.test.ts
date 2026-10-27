import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as config from '@craft-agent/shared/config'
import type { LlmConnection } from '@craft-agent/shared/config'
import { parseError } from '@craft-agent/shared/agent'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import { LIMIT_CONTINUE_PROMPT } from './connection-failover'

// Fork (connection failover): limit errors are held during the turn; at turn end the session
// either moves to the failover connection and wakes up, or the error is shown with a switch button.

const SESSION_LIMIT = "Claude Code returned an error result: You've hit your session limit · resets 5:50pm (Europe/Berlin)"

const conn = (slug: string, name: string, extra: Partial<LlmConnection> = {}): LlmConnection => ({
  slug, name, providerType: 'anthropic', authType: 'oauth', createdAt: 0, ...extra,
})

type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any

let tmpRoot: string
let sm: SessionManager
let connections: LlmConnection[]
const spies: Array<{ mockRestore(): void }> = []

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sm-failover-'))
  sm = new SessionManager()
  connections = [
    conn('claude-max', 'Claude Max Personal', { failoverConnection: 'claude-max-2' }),
    conn('claude-max-2', 'Claude Max Fluxs', { failoverConnection: 'claude-max' }),
  ]
  spies.push(spyOn(config, 'getLlmConnections').mockImplementation(() => connections))
  spies.push(spyOn(config, 'getLlmConnection').mockImplementation((slug: string) => connections.find(c => c.slug === slug) ?? null))
})

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
  rmSync(tmpRoot, { recursive: true, force: true })
})

function buildSession(id: string, messages: Array<{ id: string; role: string; content: string }>) {
  const managed: Any = createManagedSession(
    { id, name: 'failover test', llmConnection: 'claude-max', model: 'claude-opus-5-5' },
    { id: 'ws_test', name: 'Test', rootPath: tmpRoot, createdAt: 0 } as never,
    { messagesLoaded: true },
  )
  managed.messages = messages.map((m, i) => ({ ...m, timestamp: i + 1 }))
  managed.isProcessing = true
  managed.lastSentMessage = 'Bitte refaktoriere das Modul'
  managed.lastSentMessageIds = ['u1']
  managed.limitRecovery = { rateRetried: false, failedOver: false }
  ;(sm as Any).sessions.set(id, managed)
  return managed
}

function spyOnSendMessage() {
  const calls: Array<{ message: string; hidden?: boolean }> = []
  ;(sm as Any).sendMessage = async (_id: string, message: string, _a?: unknown, _s?: unknown, options?: { hidden?: boolean }) => {
    calls.push({ message, hidden: options?.hidden })
  }
  return calls
}

async function hitUsageLimit(managed: Any) {
  await (sm as Any).processEvent(managed, { type: 'typed_error', error: parseError(new Error(SESSION_LIMIT)) })
}

const settle = () => new Promise(r => setTimeout(r, 20))

describe('limit failover', () => {
  it('holds the limit error during the turn', async () => {
    const managed = buildSession('held', [{ id: 'u1', role: 'user', content: 'Bitte refaktoriere das Modul' }])
    await hitUsageLimit(managed)
    expect(managed.messages.some((m: Any) => m.role === 'error')).toBe(false)
    expect(managed.turnLimitHit?.kind).toBe('usage_limit')
  })

  it('moves an untouched turn to the failover connection and resends the request', async () => {
    const managed = buildSession('resend', [{ id: 'u1', role: 'user', content: 'Bitte refaktoriere das Modul' }])
    const calls = spyOnSendMessage()
    await hitUsageLimit(managed)

    expect((sm as Any).startLimitRecovery('resend', managed)).toBe(true)
    await settle()

    expect(managed.llmConnection).toBe('claude-max-2')
    expect(managed.model).toBe('claude-opus-5-5')
    const notice = managed.messages.find((m: Any) => m.statusType === 'connection_failover')
    expect(notice?.infoLevel).toBe('success')
    expect(notice?.content).toContain('Limit bei Claude Max Personal erreicht')
    expect(notice?.content).toContain('Weiter mit Claude Max Fluxs')
    // The failed request bubble is removed so the resend does not duplicate it.
    expect(managed.messages.some((m: Any) => m.id === 'u1')).toBe(false)
    expect(calls).toEqual([{ message: 'Bitte refaktoriere das Modul', hidden: undefined }])
    expect(sm.isConnectionLimited('claude-max')).toBe(true)
  })

  it('continues a turn that already ran tools instead of resending it', async () => {
    const managed = buildSession('continue', [
      { id: 'u1', role: 'user', content: 'Bitte refaktoriere das Modul' },
      { id: 't1', role: 'tool', content: 'Edit' },
    ])
    const calls = spyOnSendMessage()
    await hitUsageLimit(managed)

    expect((sm as Any).startLimitRecovery('continue', managed)).toBe(true)
    await settle()

    expect(managed.messages.some((m: Any) => m.id === 'u1')).toBe(true)
    expect(calls).toEqual([{ message: LIMIT_CONTINUE_PROMPT, hidden: true }])
  })

  it('shows the error with a switch button when no failover is configured', async () => {
    connections[0] = conn('claude-max', 'Claude Max Personal')
    const managed = buildSession('manual', [{ id: 'u1', role: 'user', content: 'x' }])
    spyOnSendMessage()
    await hitUsageLimit(managed)

    expect((sm as Any).startLimitRecovery('manual', managed)).toBe(false)
    const error = managed.messages.find((m: Any) => m.role === 'error')
    expect(error?.errorCode).toBe('usage_limit')
    expect(error?.errorActions?.[0]).toMatchObject({ action: 'switch_connection', connectionSlug: 'claude-max-2', label: 'Mit Claude Max Fluxs fortsetzen' })
    expect(managed.llmConnection).toBe('claude-max')
  })

  it('does not fail over twice in one turn', async () => {
    const managed = buildSession('twice', [{ id: 'u1', role: 'user', content: 'x' }])
    managed.limitRecovery = { rateRetried: false, failedOver: true }
    spyOnSendMessage()
    await hitUsageLimit(managed)

    expect((sm as Any).startLimitRecovery('twice', managed)).toBe(false)
    expect(managed.messages.some((m: Any) => m.role === 'error')).toBe(true)
  })

  it('retries a bare 429 on the same connection first', async () => {
    const managed = buildSession('throttle', [{ id: 'u1', role: 'user', content: 'x' }])
    spyOnSendMessage()
    await (sm as Any).processEvent(managed, { type: 'typed_error', error: parseError(new Error('429 Too Many Requests')) })

    expect((sm as Any).startLimitRecovery('throttle', managed)).toBe(true)
    expect(managed.limitRecovery.rateRetried).toBe(true)
    expect(managed.llmConnection).toBe('claude-max')
    expect(sm.isConnectionLimited('claude-max')).toBe(false)
    clearTimeout(managed.limitRecoveryTimer)
  })
})

describe('limit failover — recovered turns', () => {
  it('does not retry a 429 when the turn still produced its final answer', async () => {
    const managed = buildSession('recovered', [{ id: 'u1', role: 'user', content: 'x' }])
    const calls = spyOnSendMessage()
    await (sm as Any).processEvent(managed, { type: 'typed_error', error: parseError(new Error('429 Too Many Requests')) })
    managed.messages.push({ id: 'a1', role: 'assistant', content: 'Fertig.', timestamp: 9 })

    expect((sm as Any).startLimitRecovery('recovered', managed)).toBe(false)
    await settle()
    expect(calls).toEqual([])
    expect(managed.llmConnection).toBe('claude-max')
  })
})

describe('bulk move', () => {
  it('moves open idle sessions and skips archived, done and running ones', async () => {
    const open = buildSession('open', [{ id: 'u1', role: 'user', content: 'x' }]); open.isProcessing = false
    const done = buildSession('done', []); done.isProcessing = false; done.sessionStatus = 'done'
    const archived = buildSession('archived', []); archived.isProcessing = false; archived.isArchived = true
    const running = buildSession('running', [])

    const result = await sm.migrateConnectionSessions('claude-max', 'claude-max-2')

    expect(result).toEqual({ moved: 1, skippedRunning: 1 })
    expect(open.llmConnection).toBe('claude-max-2')
    expect(done.llmConnection).toBe('claude-max')
    expect(archived.llmConnection).toBe('claude-max')
    expect(running.llmConnection).toBe('claude-max')
  })

  it('refuses to move sessions to another provider type', async () => {
    connections.push(conn('chatgpt', 'ChatGPT', { providerType: 'pi' }))
    await expect(sm.migrateConnectionSessions('claude-max', 'chatgpt')).rejects.toThrow()
  })
})
