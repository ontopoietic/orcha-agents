import { describe, expect, it } from 'bun:test'
import { createUnknownSessionHydrator } from '../unknown-session-hydration'
import { getSessionTitle } from '../../utils/session'

type S = { id: string; name?: string; preview?: string }

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('createUnknownSessionHydrator', () => {
  it('hydrates a session first seen via an event so its explicit name wins over the stub', async () => {
    // Simulates: sessions:create RPC (no session_created broadcast) → first event
    // builds a nameless stub → hydrate replaces it with the stored session.
    const list = new Map<string, S>()
    list.set('s1', { id: 's1' }) // stub from processAgentEvent(createEmptySession)
    const hydrator = createUnknownSessionHydrator<S>({
      fetchSession: async (id) => ({ id, name: 'SMOKE-X' }),
      applySession: (s) => list.set(s.id, s),
    })

    expect(hydrator.maybeHydrate('s1', false)).toBe(true)
    await flush()
    expect(getSessionTitle(list.get('s1')!)).toBe('SMOKE-X')
  })

  it('does nothing for sessions the window already knows', async () => {
    let fetches = 0
    const hydrator = createUnknownSessionHydrator<S>({
      fetchSession: async (id) => { fetches++; return { id } },
      applySession: () => {},
    })
    expect(hydrator.maybeHydrate('s1', true)).toBe(false)
    await flush()
    expect(fetches).toBe(0)
  })

  it('dedupes concurrent events for the same unknown session', async () => {
    let fetches = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const hydrator = createUnknownSessionHydrator<S>({
      fetchSession: async (id) => { fetches++; await gate; return { id, name: 'n' } },
      applySession: () => {},
    })
    expect(hydrator.maybeHydrate('s1', false)).toBe(true)
    expect(hydrator.maybeHydrate('s1', false)).toBe(false)
    release()
    await flush()
    expect(fetches).toBe(1)
  })

  it('ignores a null fetch result (session deleted meanwhile) and reports errors', async () => {
    const applied: S[] = []
    const errors: unknown[] = []
    const hydrator = createUnknownSessionHydrator<S>({
      fetchSession: async (id) => (id === 'gone' ? null : Promise.reject(new Error('boom'))),
      applySession: (s) => applied.push(s),
      onError: (e) => errors.push(e),
    })
    hydrator.maybeHydrate('gone', false)
    hydrator.maybeHydrate('bad', false)
    await flush()
    expect(applied).toEqual([])
    expect(errors).toHaveLength(1)
  })
})
