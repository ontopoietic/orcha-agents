import { describe, expect, it } from 'bun:test'
import {
  createSignInRunner,
  raceDeadline,
  waitForJoinedOAuthFlow,
  SIGN_IN_RESTARTED,
  SIGN_IN_TIMED_OUT,
  type SourceOAuthArgs,
  type SourceOAuthResult,
} from '../source-oauth'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

describe('createSignInRunner', () => {
  function recordingRunner() {
    const runs: Array<{ args: SourceOAuthArgs; signal: AbortSignal; finish: (r: SourceOAuthResult) => void }> = []
    const performOAuth = createSignInRunner((args, signal) => {
      const done = deferred<SourceOAuthResult>()
      runs.push({ args, signal, finish: done.resolve })
      return done.promise
    })
    return { runs, performOAuth }
  }

  it('a repeat click on the same card shares the running sign-in', async () => {
    const { runs, performOAuth } = recordingRunner()
    const card = { sourceSlug: 'gmail', sessionId: 's1', authRequestId: 'a1' }

    const first = performOAuth(card)
    const second = performOAuth(card)
    expect(second).toBe(first)
    expect(runs).toHaveLength(1)

    runs[0]!.finish({ success: true })
    expect(await first).toEqual({ success: true })
    await Promise.resolve()

    // Settled: the next click runs again
    performOAuth(card)
    expect(runs).toHaveLength(2)
  })

  it('another card for the same source runs its own call (the server decides whether it joins)', () => {
    const { runs, performOAuth } = recordingRunner()

    performOAuth({ sourceSlug: 'gmail', sessionId: 's1', authRequestId: 'a1' })
    performOAuth({ sourceSlug: 'gmail', sessionId: 's2', authRequestId: 'a2' })

    expect(runs).toHaveLength(2)
  })

  it('a restart abandons every running sign-in for the source, and only that source', () => {
    const { runs, performOAuth } = recordingRunner()

    performOAuth({ sourceSlug: 'gmail', sessionId: 's1', authRequestId: 'a1' })
    performOAuth({ sourceSlug: 'gmail', sessionId: 's2', authRequestId: 'a2' })
    performOAuth({ sourceSlug: 'slack', sessionId: 's3', authRequestId: 'a3' })
    performOAuth({ sourceSlug: 'gmail', sessionId: 's2', authRequestId: 'a2', restart: true })

    expect(runs).toHaveLength(4)
    expect(runs.map(r => r.signal.aborted)).toEqual([true, true, false, false])
    expect(runs[3]!.args.restart).toBe(true)
  })
})

describe('waitForJoinedOAuthFlow', () => {
  it('polls until the joined flow ends and reports how it ended', async () => {
    const statuses = [{ live: true }, { live: true }, { live: false, outcome: { success: true, email: 'me@example.com' } }]
    const calls: unknown[][] = []
    const invoke = async (...args: unknown[]) => { calls.push(args); return statuses.shift() }

    const result = await waitForJoinedOAuthFlow(invoke, 'flow-1', { timeoutMs: 1000, pollIntervalMs: 1 })

    expect(result).toEqual({ success: true, email: 'me@example.com' })
    expect(calls).toEqual([
      ['oauth:status', { flowId: 'flow-1' }],
      ['oauth:status', { flowId: 'flow-1' }],
      ['oauth:status', { flowId: 'flow-1' }],
    ])
  })

  it('keeps waiting through a transport hiccup', async () => {
    let n = 0
    const invoke = async () => {
      if (++n === 1) throw new Error('Request timeout')
      return { live: false, outcome: { success: false, error: 'access_denied' } }
    }

    expect(await waitForJoinedOAuthFlow(invoke, 'flow-1', { timeoutMs: 1000, pollIntervalMs: 1 }))
      .toEqual({ success: false, error: 'access_denied' })
  })

  it('reports a failure when the flow vanished without an outcome', async () => {
    const result = await waitForJoinedOAuthFlow(async () => ({ live: false }), 'flow-1', { timeoutMs: 1000, pollIntervalMs: 1 })
    expect(result.success).toBe(false)
  })

  it('gives up when the flow lifetime runs out', async () => {
    const result = await waitForJoinedOAuthFlow(async () => ({ live: true }), 'flow-1', { timeoutMs: 20, pollIntervalMs: 5 })
    expect(result).toEqual(SIGN_IN_TIMED_OUT)
  })

  it('stops at once when the sign-in is restarted', async () => {
    const controller = new AbortController()
    const waiting = waitForJoinedOAuthFlow(async () => ({ live: true }), 'flow-1', {
      timeoutMs: 60_000,
      pollIntervalMs: 60_000,
      signal: controller.signal,
    })
    controller.abort()
    expect(await waiting).toEqual(SIGN_IN_RESTARTED)
  })
})

describe('raceDeadline', () => {
  it('settles with the value, or null on timeout or abort', async () => {
    expect(await raceDeadline(Promise.resolve('callback'), 1000)).toBe('callback')
    expect(await raceDeadline(new Promise(() => {}), 5)).toBeNull()

    const controller = new AbortController()
    const racing = raceDeadline(new Promise(() => {}), 60_000, controller.signal)
    controller.abort()
    expect(await racing).toBeNull()
    expect(await raceDeadline(Promise.resolve('late'), 1000, controller.signal)).toBeNull()
  })

  it('passes errors through', async () => {
    await expect(raceDeadline(Promise.reject(new Error('EADDRINUSE')), 1000)).rejects.toThrow('EADDRINUSE')
  })
})
