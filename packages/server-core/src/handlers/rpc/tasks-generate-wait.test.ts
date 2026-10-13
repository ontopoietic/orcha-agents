import { describe, expect, it } from 'bun:test'
import type { SessionCompletionEvent } from '../../sessions/SessionManager'
import { waitForTurnReply } from './tasks'

// Found 2026-10-11: a fixed 180 s limit failed authoring turns that were slow but still writing.
// A turn now fails only when it stops making progress, or runs past a generous cap.
function fakeSessions() {
  const completion = new Set<(evt: SessionCompletionEvent) => void>()
  const activity = new Set<() => void>()
  return {
    sessions: {
      onSessionComplete: (listener: (evt: SessionCompletionEvent) => void) => { completion.add(listener); return () => { completion.delete(listener) } },
      onSessionActivity: (_sessionId: string, listener: () => void) => { activity.add(listener); return () => { activity.delete(listener) } },
    },
    complete: (evt: Partial<SessionCompletionEvent>) => { for (const l of [...completion]) l({ sessionId: 's', workspaceId: 'w', reason: 'complete', ...evt }) },
    act: () => { for (const l of [...activity]) l() },
    listeners: () => completion.size + activity.size,
  }
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('waitForTurnReply', () => {
  it('keeps waiting while the turn shows activity, and resolves with its reply', async () => {
    const fake = fakeSessions()
    const reply = waitForTurnReply(fake.sessions, 's', () => {}, { idleMs: 40, maxMs: 1_000 })
    for (let i = 0; i < 5; i++) { await sleep(20); fake.act() } // 100 ms in all, never 40 ms idle
    fake.complete({ finalText: 'id: demo' })
    expect(await reply).toBe('id: demo')
    expect(fake.listeners()).toBe(0)
  })

  it('fails a turn that stops making progress', async () => {
    const fake = fakeSessions()
    const reply = waitForTurnReply(fake.sessions, 's', () => {}, { idleMs: 30, maxMs: 1_000 })
    await expect(reply).rejects.toThrow('stalled')
    expect(fake.listeners()).toBe(0)
  })

  it('fails a working turn at the cap', async () => {
    const fake = fakeSessions()
    const reply = waitForTurnReply(fake.sessions, 's', () => {}, { idleMs: 40, maxMs: 80 })
    const ticker = setInterval(fake.act, 10)
    try {
      await expect(reply).rejects.toThrow('timed out')
    } finally {
      clearInterval(ticker)
    }
  })

  it('fails at once on a stopped or failed turn, and on a failed send', async () => {
    const stopped = fakeSessions()
    const a = waitForTurnReply(stopped.sessions, 's', () => {}, { idleMs: 1_000 })
    stopped.complete({ reason: 'interrupted' })
    await expect(a).rejects.toThrow('stopped')

    const failed = fakeSessions()
    const b = waitForTurnReply(failed.sessions, 's', () => {}, { idleMs: 1_000 })
    failed.complete({ reason: 'error' })
    await expect(b).rejects.toThrow('failed')

    const unsent = fakeSessions()
    await expect(waitForTurnReply(unsent.sessions, 's', () => { throw new Error('no session') }, { idleMs: 1_000 })).rejects.toThrow('no session')
  })

  it('ignores other sessions', async () => {
    const fake = fakeSessions()
    const reply = waitForTurnReply(fake.sessions, 's', () => {}, { idleMs: 1_000 })
    fake.complete({ sessionId: 'other', finalText: 'nope' })
    fake.complete({ finalText: 'mine' })
    expect(await reply).toBe('mine')
  })
})
