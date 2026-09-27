import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPendingPlanExecution, saveSession } from '../../../shared/src/sessions/storage.ts'
import * as backendFactory from '../../../shared/src/agent/backend/factory.ts'
import { ClaudeAgent } from '../../../shared/src/agent/claude-agent.ts'
import { PendingSteers } from '../../../shared/src/agent/backend/claude/pending-steers.ts'
import {
  SessionManager,
  createManagedSession,
  resolveMidStreamDeliveryOutcome,
  canSteerTextPayload,
} from './SessionManager.ts'

describe('mid-stream queue runtime invariants', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-midstream-'))
    sm = new SessionManager()
  })

  afterEach(() => {
    mock.restore()
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildSession(id: string) {
    const workspace = {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id, name: 'mid-stream test' },
      workspace as never,
      { messagesLoaded: true },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  it('distinguishes non-interrupting queue mode from a failed steer', () => {
    expect(resolveMidStreamDeliveryOutcome('queue', false)).toEqual({
      shouldQueue: true,
      wasInterrupted: false,
    })
    expect(resolveMidStreamDeliveryOutcome('steer', false)).toEqual({
      shouldQueue: true,
      wasInterrupted: true,
    })
    expect(resolveMidStreamDeliveryOutcome('steer', true)).toEqual({
      shouldQueue: false,
      wasInterrupted: false,
    })
  })

  it('recovers distinct identical-text steers by identity without interrupting or duplicating', async () => {
    const managed = buildSession('recover')
    const payloads = ['a', 'b', 'c'].map(messageId => ({ message: 'same', messageId, optimisticMessageId: `optimistic-${messageId}` }))
    managed.messages = payloads.map(p => ({ id: p.messageId, content: p.message, role: 'user', timestamp: 1 }))
    ;(managed as any).acceptedSteers = new Map(payloads.map(p => [p.messageId, p]))
    ;(sm as any).persistSession = () => {}
    for (const p of payloads) await (sm as any).processEvent(managed, { type: 'steer_undelivered', message: p.message, messageId: p.messageId })
    expect(managed.messageQueue).toEqual(payloads)
    expect(managed.messages).toHaveLength(3)
    expect(managed.messages.every(m => m.isQueued)).toBe(true)
    expect(managed.wasInterrupted).not.toBe(true)
    await (sm as any).processEvent(managed, { type: 'steer_undelivered', message: 'same', messageId: 'a' })
    expect(managed.messageQueue).toHaveLength(3)
  })

  it('allows empty presentation metadata but queues semantic and future options', () => {
    expect(canSteerTextPayload([], [], { skillSlugs: [], badges: [], hidden: false, optimisticMessageId: 'id' })).toBe(true)
    expect(canSteerTextPayload(undefined, undefined, { skillSlugs: ['skill'] })).toBe(false)
    expect(canSteerTextPayload(undefined, undefined, { hidden: true })).toBe(false)
    expect(canSteerTextPayload(undefined, undefined, { futureOption: false } as any)).toBe(false)
    expect(canSteerTextPayload(undefined, [{ id: 'stored' }] as any)).toBe(false)
  })

  it('queues attachments and semantic options intact without calling a text-only redirect', async () => {
    spyOn(backendFactory, 'resolveSessionConnection').mockReturnValue({ providerType: 'pi', midStreamBehavior: 'steer' } as any)
    const managed = buildSession('attachments')
    managed.isProcessing = true
    const redirect = mock(() => true)
    managed.agent = { redirect } as any
    ;(sm as any).persistSession = () => {}
    ;(sm as any).flushSession = async () => {}
    const attachments = [{ name: 'photo.png', type: 'image', mimeType: 'image/png', base64: 'image-bytes' }] as any
    const storedAttachments = [{ id: 'file', name: 'photo.png', type: 'image', storedPath: '/tmp/photo.png' }] as any
    const options = { skillSlugs: ['image-skill'], hidden: true, optimisticMessageId: 'optimistic' }
    const events: any[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))
    await sm.sendMessage(managed.id, 'inspect image', attachments, storedAttachments, options)
    expect(redirect).not.toHaveBeenCalled()
    expect(managed.wasInterrupted).not.toBe(true)
    expect(managed.messageQueue[0]).toMatchObject({ attachments, storedAttachments, options, messageId: managed.messages[0]!.id })
    expect(managed.messages[0]!.isQueued).toBe(true)
    expect(events.find(e => e.type === 'user_message').status).toBe('queued')
    // Also prove the existing supported replay path receives the same objects.
    const replay = mock(async (..._args: unknown[]) => {})
    ;(sm as any).sendMessage = replay
    ;(sm as any).processNextQueuedMessage(managed.id)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(replay.mock.calls[0]).toEqual([managed.id, 'inspect image', attachments, storedAttachments, options, managed.messages[0]!.id])
  })

  it('marks Accept & Compact ready only after a manual compaction success and preserves the fresh snapshot', async () => {
    const managed = buildSession('manual-compact-ready')
    managed.isProcessing = true
    managed.tokenUsage = { inputTokens: 419_000, outputTokens: 10, totalTokens: 419_010, contextTokens: 0, costUsd: 0 }
    await saveSession({ id: managed.id, workspaceRootPath: tmpRoot, createdAt: 1, lastUsedAt: 1, messages: [], tokenUsage: managed.tokenUsage } as any)
    await sm.setPendingPlanExecution(managed.id, '/tmp/plan.md', 'draft')
    const events: any[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))
    ;(sm as any).persistSession = () => {}

    await (sm as any).processEvent(managed, { type: 'context_usage', contextUsage: { usedTokens: 12_000, limitTokens: 200_000, limitKind: 'compaction', isEstimate: true, isStale: false, canCompact: true } })
    await (sm as any).processEvent(managed, { type: 'info', message: 'Compacted Conversation', compactionTrigger: 'manual' })

    expect(getPendingPlanExecution(tmpRoot, managed.id)).toMatchObject({ awaitingCompaction: false, executionDispatched: false })
    expect(managed.tokenUsage.contextUsage?.usedTokens).toBe(12_000)
    expect(events.find(e => e.type === 'usage_update').tokenUsage.contextUsage.usedTokens).toBe(12_000)
    expect(events.find(e => e.type === 'info')).toMatchObject({ statusType: 'compaction_complete' })
    expect(await sm.markPendingPlanExecutionDispatched(managed.id)).toBe(false)
    managed.isProcessing = false
    expect(await sm.markPendingPlanExecutionDispatched(managed.id)).toBe(true)
    expect(await sm.markPendingPlanExecutionDispatched(managed.id)).toBe(false)
  })

  it('does not release pending plan execution for auto or failed compaction outcomes', async () => {
    for (const [id, event] of [
      ['auto-compact', { type: 'info', message: 'Compacted Conversation', compactionTrigger: 'auto' }],
      ['failed-compact', { type: 'compaction_failed' }],
    ] as const) {
      const managed = buildSession(id)
      await saveSession({ id: managed.id, workspaceRootPath: tmpRoot, createdAt: 1, lastUsedAt: 1, messages: [], tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } } as any)
      await sm.setPendingPlanExecution(managed.id, '/tmp/plan.md')
      ;(sm as any).persistSession = () => {}
      await (sm as any).processEvent(managed, event)
      managed.isProcessing = false
      expect(await sm.markPendingPlanExecutionDispatched(managed.id)).toBe(false)
      const pending = getPendingPlanExecution(tmpRoot, managed.id)
      if (id === 'auto-compact') expect(pending).toMatchObject({ awaitingCompaction: true, executionDispatched: false })
      else expect(pending).toBeNull()
    }
  })

  it('keeps the pending plan record while sending the /compact command that releases it', async () => {
    const managed = buildSession('send-compact')
    await saveSession({ id: managed.id, workspaceRootPath: tmpRoot, createdAt: 1, lastUsedAt: 1, messages: [], tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } } as any)
    await sm.setPendingPlanExecution(managed.id, '/tmp/plan.md')
    const agent = {
      getModel: () => 'claude-sonnet-4-6',
      setAllSources: () => {},
      getSessionId: () => 'sdk-session',
      chat: async function* () {
        yield { type: 'context_usage', contextUsage: { usedTokens: 12_000, limitTokens: 200_000, limitKind: 'compaction', isEstimate: true, isStale: false, canCompact: true } }
        yield { type: 'info', message: 'Compacted Conversation', compactionTrigger: 'manual' }
        yield { type: 'complete' }
      },
    }
    ;(sm as any).getOrCreateAgent = async () => agent
    sm.setEventSink(() => {})
    await sm.sendMessage(managed.id, '/compact')
    expect(getPendingPlanExecution(tmpRoot, managed.id)).toMatchObject({ awaitingCompaction: false, executionDispatched: false })
  })

  it('the actual host sendMessage loop consumes Claude recovery before stopping at complete', async () => {
    spyOn(backendFactory, 'resolveSessionConnection').mockReturnValue({ providerType: 'pi', midStreamBehavior: 'steer' } as any)
    const managed = buildSession('host-completion')
    managed.sdkSessionId = 'offline-sdk'
    const agent = Object.create(ClaudeAgent.prototype) as any
    agent.pendingSteers = new PendingSteers()
    agent.currentQuery = { interrupt: async () => {} }
    agent.currentQueryAbortController = new AbortController()
    agent.debug = () => {}
    agent.getModel = () => 'claude-sonnet-4-6'
    agent.setAllSources = () => {}
    agent.getSessionId = () => 'offline-sdk'
    agent.chat = agent.chatImpl.bind(agent)
    const acceptedIds: string[] = []
    agent.chatTurn = async function* () {
      for (const id of ['a', 'b', 'c']) {
        await sm.sendMessage(managed.id, 'same', undefined, undefined, { optimisticMessageId: `opt-${id}` })
        acceptedIds.push(managed.messages.at(-1)!.id)
      }
      yield { type: 'complete' }
    }
    managed.agent = agent
    ;(sm as any).getOrCreateAgent = async () => agent
    ;(sm as any).persistSession = () => {}
    ;(sm as any).flushSession = async () => {}
    const stopped = mock(async () => { managed.isProcessing = false })
    ;(sm as any).onProcessingStopped = stopped
    const events: any[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))
    await sm.sendMessage(managed.id, 'initial')
    expect(stopped).toHaveBeenCalledTimes(1)
    expect(managed.messageQueue.map(p => p.messageId)).toEqual(acceptedIds)
    expect(managed.messageQueue.map(p => p.optimisticMessageId)).toEqual(['opt-a', 'opt-b', 'opt-c'])
    expect(managed.messages.filter(m => m.role === 'user')).toHaveLength(4)
    expect(managed.wasInterrupted).not.toBe(true)
    expect(events.filter(e => e.type === 'user_message' && e.status === 'queued').map(e => e.message.id)).toEqual(acceptedIds)
  })

  // ORCHA regression (steer-delivery, 2026-09-27): live smoke test on the
  // default claude-max connection (providerType 'anthropic', no explicit
  // midStreamBehavior). "Wort: APFEL" / "Wort: BIRNE" sent during Bash #1 were
  // queued instead of steered, so the model never saw them at the Bash #2 tool
  // boundary and they were replayed as follow-up turns afterwards.
  function steeringClaudeAgent(options: { liveQuery: boolean }) {
    const agent = Object.create(ClaudeAgent.prototype) as any
    agent.pendingSteers = new PendingSteers()
    agent.currentQuery = options.liveQuery ? { interrupt: async () => {} } : null
    agent.currentQueryAbortController = options.liveQuery ? new AbortController() : null
    agent.debug = () => {}
    agent.getModel = () => 'claude-sonnet-5'
    agent.setAllSources = () => {}
    agent.getSessionId = () => 'offline-sdk'
    agent.chat = agent.chatImpl.bind(agent)
    // The production PendingSteers wrapper around a plain "allow" PreToolUse result.
    const toolBoundary = agent.pendingSteers.wrapHook(async () => ({ continue: true }))
    const bash = async () => ((await toolBoundary(
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'tool', tool_input: { command: 'sleep 8' } }, 'tool', {},
    )) as any).hookSpecificOutput?.additionalContext as string | undefined
    return { agent, bash }
  }

  function wireHost(managed: any, agent: any) {
    managed.sdkSessionId = 'offline-sdk'
    managed.agent = agent
    ;(sm as any).getOrCreateAgent = async () => agent
    ;(sm as any).persistSession = () => {}
    ;(sm as any).flushSession = async () => {}
    const stopped = mock(async () => { managed.isProcessing = false })
    ;(sm as any).onProcessingStopped = stopped
    const events: any[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))
    return { stopped, events }
  }

  it('default Claude connection steers mid-turn sends into the next tool boundary, in order, exactly once', async () => {
    spyOn(backendFactory, 'resolveSessionConnection').mockReturnValue({ providerType: 'anthropic' } as any)
    const managed = buildSession('default-claude-steer')
    const { agent, bash } = steeringClaudeAgent({ liveQuery: true })
    const contexts: Array<string | undefined> = []
    agent.chatTurn = async function* () {
      contexts.push(await bash()) // Bash #1 starts
      await sm.sendMessage(managed.id, 'Wort: APFEL')
      await sm.sendMessage(managed.id, 'Wort: BIRNE')
      contexts.push(await bash()) // Bash #2 — first boundary after the sends
      contexts.push(await bash()) // Bash #3
      yield { type: 'complete' }
    }
    const { stopped, events } = wireHost(managed, agent)
    await sm.sendMessage(managed.id, 'run sleep 8 three times, then list my words')

    expect(contexts[0]).toBeUndefined()
    expect(contexts[1]).toContain('Message 1:\nWort: APFEL')
    expect(contexts[1]).toContain('Message 2:\nWort: BIRNE')
    expect(contexts[1]!.indexOf('APFEL')).toBeLessThan(contexts[1]!.indexOf('BIRNE'))
    expect(contexts[2]).toBeUndefined()
    // Delivered in-turn → nothing left to replay as follow-up turns.
    expect(managed.messageQueue).toEqual([])
    expect(stopped).toHaveBeenCalledTimes(1)
    expect(managed.wasInterrupted).not.toBe(true)
    const midStream = events.filter(e => e.type === 'user_message' && e.message.content.startsWith('Wort:'))
    expect(midStream.map(e => e.status)).toEqual(['accepted', 'accepted'])
  })

  it('accepts a steer sent before the SDK query exists and keeps steering the rest of the turn', async () => {
    spyOn(backendFactory, 'resolveSessionConnection').mockReturnValue({ providerType: 'anthropic' } as any)
    const managed = buildSession('prequery-steer')
    const { agent, bash } = steeringClaudeAgent({ liveQuery: false })
    const forceAbort = spyOn(agent, 'forceAbort')
    const contexts: Array<string | undefined> = []
    agent.chatTurn = async function* () {
      // Prompt building (observations/recall/tail) — no query() yet.
      await sm.sendMessage(managed.id, 'Wort: APFEL')
      agent.currentQuery = { interrupt: async () => {} }
      agent.currentQueryAbortController = new AbortController()
      contexts.push(await bash())
      await sm.sendMessage(managed.id, 'Wort: BIRNE')
      contexts.push(await bash())
      yield { type: 'complete' }
    }
    const { stopped } = wireHost(managed, agent)
    await sm.sendMessage(managed.id, 'task')

    expect(forceAbort).not.toHaveBeenCalled()
    expect(agent.currentQueryAbortController.signal.aborted).toBe(false)
    expect(contexts[0]).toContain('Wort: APFEL')
    expect(contexts[0]).not.toContain('BIRNE')
    expect(contexts[1]).toContain('Wort: BIRNE')
    expect(contexts[1]).not.toContain('APFEL')
    expect(managed.messageQueue).toEqual([])
    expect(managed.wasInterrupted).not.toBe(true)
    expect(stopped).toHaveBeenCalledTimes(1)
  })

  it('a steer that finds no tool boundary is replayed exactly once, with no interruption marker', async () => {
    spyOn(backendFactory, 'resolveSessionConnection').mockReturnValue({ providerType: 'anthropic' } as any)
    const managed = buildSession('no-boundary')
    const { agent } = steeringClaudeAgent({ liveQuery: true })
    agent.chatTurn = async function* () {
      await sm.sendMessage(managed.id, 'Wort: APFEL')
      await sm.sendMessage(managed.id, 'Wort: BIRNE')
      yield { type: 'complete' }
    }
    wireHost(managed, agent)
    await sm.sendMessage(managed.id, 'answer without tools')
    expect(managed.messageQueue.map(p => p.message)).toEqual(['Wort: APFEL', 'Wort: BIRNE'])
    expect(managed.messages.filter(m => m.content === 'Wort: BIRNE')).toHaveLength(1)
    expect(managed.messages.filter(m => m.content.startsWith('Wort:')).every(m => m.isQueued)).toBe(true)
    expect(managed.wasInterrupted).not.toBe(true)
  })

  it.each(['complete', 'error'])('ignores a trailing %s from a handed-off turn after a newer turn starts', async terminal => {
    const managed = buildSession('handoff-new-turn')
    managed.sdkSessionId = 'offline-sdk'
    const agent = Object.create(ClaudeAgent.prototype) as any
    agent.pendingSteers = new PendingSteers()
    agent.currentQuery = { interrupt: async () => {} }
    agent.currentQueryAbortController = new AbortController()
    agent.debug = () => {}
    agent.getModel = () => 'claude-sonnet-4-6'
    agent.setAllSources = () => {}
    agent.getSessionId = () => 'offline-sdk'
    agent.chat = agent.chatImpl.bind(agent)
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    const starts = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    let turn = 0
    agent.chatTurn = async function* () {
      const index = turn++
      starts[index]!.resolve()
      await gates[index]!.promise
      if (index === 0 && terminal === 'error') throw new Error('old query aborted')
      yield { type: 'complete' }
    }
    managed.agent = agent
    ;(sm as any).getOrCreateAgent = async () => agent
    ;(sm as any).persistSession = () => {}
    ;(sm as any).flushSession = async () => {}
    const stopped = mock(async () => { managed.isProcessing = false })
    ;(sm as any).onProcessingStopped = stopped
    const first = sm.sendMessage(managed.id, 'first')
    await starts[0]!.promise
    ;(sm as any).recoverPendingSteers(managed)
    managed.isProcessing = false // The UI handoff callback pauses without waiting for the old SDK result.
    const second = sm.sendMessage(managed.id, 'second')
    await starts[1]!.promise
    gates[0]!.resolve()
    try {
      await first
      expect(stopped).not.toHaveBeenCalled()
      expect(managed.isProcessing).toBe(true)
    } finally {
      gates[1]!.resolve()
      await second
    }
    expect(stopped).toHaveBeenCalledTimes(1)
  })

  it('transfers handoff steers ahead of already queued later attachments', () => {
    const managed = buildSession('handoff-order')
    managed.messages = ['a', 'b', 'c'].map(id => ({ id, role: 'user', content: id, timestamp: 1 }))
    const payloads = ['a', 'c'].map(messageId => ({ message: messageId, messageId }))
    managed.acceptedSteers = new Map(payloads.map(p => [p.messageId, p]))
    managed.messageQueue = [{ message: 'b', messageId: 'b', attachments: [{ name: 'keep' }] as any }]
    managed.agent = { takePendingSteers: () => payloads } as any
    ;(sm as any).persistSession = () => {}
    ;(sm as any).recoverPendingSteers(managed)
    expect(managed.messageQueue.map(p => p.messageId)).toEqual(['a', 'b', 'c'])
    expect(managed.messageQueue[1]!.attachments).toEqual([{ name: 'keep' }] as any)
    expect(managed.wasInterrupted).not.toBe(true)
  })

  it('hard Stop visibly cancels accepted pending steers and rejects trailing recovery', async () => {
    const managed = buildSession('stop')
    managed.isProcessing = true
    managed.messages = [{ id: 'a', role: 'user', content: 'pending', timestamp: 1 }]
    const payload = { message: 'pending', messageId: 'a' }
    managed.acceptedSteers = new Map([['a', payload]])
    const forceAbort = mock(() => {})
    managed.agent = { takePendingSteers: () => [payload], forceAbort } as any
    ;(sm as any).persistSession = () => {}
    const events: any[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))
    await sm.cancelProcessing(managed.id)
    expect(forceAbort).toHaveBeenCalledTimes(1)
    expect(events.find(e => e.type === 'interrupted').queuedMessages).toEqual(['pending'])
    expect(managed.messages.some(m => m.id === 'a')).toBe(false)
    expect(managed.messageQueue).toEqual([])
    await (sm as any).processEvent(managed, { type: 'steer_undelivered', ...payload })
    expect(managed.messageQueue).toEqual([])
    managed.isProcessing = false // Disarm the production Stop backstop timer.
  })

  it('re-stamps replay after the prior final response and emits that timestamp', async () => {
    const sessionId = 'queue-ordering'
    const managed = buildSession(sessionId)
    const priorFinalTimestamp = Date.now()
    managed.messages = [
      {
        id: 'initial-user',
        role: 'user',
        content: 'question',
        timestamp: priorFinalTimestamp - 200,
      },
      {
        id: 'queued-user',
        role: 'user',
        content: 'follow up',
        timestamp: priorFinalTimestamp - 100,
        isQueued: true,
      },
      {
        id: 'prior-answer',
        role: 'assistant',
        content: 'complete answer',
        timestamp: priorFinalTimestamp,
      },
    ]
    managed.messageQueue.push({
      message: 'follow up',
      messageId: 'queued-user',
      optimisticMessageId: 'optimistic-user',
    })

    const events: any[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))
    ;(sm as unknown as { lastTimestamp: number }).lastTimestamp = priorFinalTimestamp
    ;(sm as unknown as { persistSession: () => void }).persistSession = () => {}
    const sendMessage = mock(async () => {})
    ;(sm as unknown as { sendMessage: typeof sendMessage }).sendMessage = sendMessage

    ;(sm as unknown as { processNextQueuedMessage: (id: string) => void })
      .processNextQueuedMessage(sessionId)
    await new Promise<void>(resolve => setImmediate(resolve))

    const replayed = managed.messages.find(message => message.id === 'queued-user')
    expect(replayed?.isQueued).toBe(false)
    expect(replayed?.timestamp).toBeGreaterThan(priorFinalTimestamp)

    const processingEvent = events.find(event => event.type === 'user_message')
    expect(processingEvent?.status).toBe('processing')
    expect(processingEvent?.message.timestamp).toBe(replayed?.timestamp)
    expect(processingEvent?.optimisticMessageId).toBe('optimistic-user')
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })
})
