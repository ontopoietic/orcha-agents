// ORCHA §session-nesting: SessionManager.archiveSession / unarchiveSession cascade
import { beforeEach, describe, expect, it } from 'bun:test'
import { SessionManager, createManagedSession } from './SessionManager.ts'

type Managed = ReturnType<typeof createManagedSession>

describe('SessionManager archive cascade', () => {
  let sm: SessionManager
  let events: Array<{ type: string; sessionId: string }>
  let persisted: string[]

  const ws = { id: 'ws_test', name: 'Test', rootPath: '/nonexistent-ws', createdAt: 0 }
  const otherWs = { id: 'ws_other', name: 'Other', rootPath: '/nonexistent-ws2', createdAt: 0 }

  function add(id: string, opts: Partial<Managed> = {}, workspace = ws): Managed {
    const managed = createManagedSession({ id, ...opts }, workspace as never, { messagesLoaded: true })
    ;(sm as unknown as { sessions: Map<string, Managed> }).sessions.set(id, managed)
    return managed
  }
  const get = (id: string) => (sm as unknown as { sessions: Map<string, Managed> }).sessions.get(id)!

  beforeEach(() => {
    sm = new SessionManager()
    events = []
    persisted = []
    const internals = sm as unknown as Record<string, unknown>
    internals.persistSession = (m: Managed) => { persisted.push(m.id) }
    internals.flushSession = async () => {}
    internals.emitUnreadSummaryChanged = () => {}
    sm.setEventSink((_channel: string, _target: unknown, ...payload: unknown[]) => {
      const e = payload[0] as { type: string; sessionId: string }
      if (e?.type === 'session_archived' || e?.type === 'session_unarchived') events.push({ type: e.type, sessionId: e.sessionId })
    })
  })

  it('archiving the orchestrator cascades to its node sessions (and emits per session)', async () => {
    add('conductor')
    add('orch', { parentSessionId: 'conductor' })
    add('node1', { parentSessionId: 'orch' })
    add('node2', { parentSessionId: 'orch' })
    add('unrelated')

    await sm.archiveSession('orch')

    expect(get('orch').isArchived).toBe(true)
    expect(get('orch').archivedByCascadeFrom).toBeUndefined()
    for (const id of ['node1', 'node2']) {
      expect(get(id).isArchived).toBe(true)
      expect(get(id).archivedByCascadeFrom).toBe('orch')
      expect(get(id).archivedAt).toBeNumber()
    }
    expect(get('conductor').isArchived).toBeFalsy()
    expect(get('unrelated').isArchived).toBeFalsy()
    expect(events.map(e => e.sessionId).sort()).toEqual(['node1', 'node2', 'orch'])
    expect(events.every(e => e.type === 'session_archived')).toBe(true)
    expect(persisted.sort()).toEqual(['node1', 'node2', 'orch'])
  })

  it('does not touch already-archived descendants but traverses through them', async () => {
    add('conductor')
    add('orch', { parentSessionId: 'conductor', isArchived: true, archivedAt: 1 })
    add('node', { parentSessionId: 'orch' })

    await sm.archiveSession('conductor')

    expect(get('orch').archivedAt).toBe(1)
    expect(get('orch').archivedByCascadeFrom).toBeUndefined()
    expect(get('node').archivedByCascadeFrom).toBe('conductor')
  })

  it('unarchive restores only cascade-archived descendants; manual archives stay', async () => {
    add('root')
    add('a', { parentSessionId: 'root' })
    add('manual', { parentSessionId: 'root', isArchived: true, archivedAt: 1 })
    add('b', { parentSessionId: 'manual' })

    await sm.archiveSession('root')
    expect(get('b').archivedByCascadeFrom).toBe('root')
    events = []

    await sm.unarchiveSession('root')

    expect(get('root').isArchived).toBe(false)
    expect(get('a').isArchived).toBe(false)
    expect(get('a').archivedByCascadeFrom).toBeUndefined()
    expect(get('b').isArchived).toBe(false)
    expect(get('manual').isArchived).toBe(true)
    expect(events.map(e => e.sessionId).sort()).toEqual(['a', 'b', 'root'])
    expect(events.every(e => e.type === 'session_unarchived')).toBe(true)
  })

  it('unarchiving a cascade-archived child alone clears its marker and restores its own cascade', async () => {
    add('root')
    add('mid', { parentSessionId: 'root' })
    add('leaf', { parentSessionId: 'mid' })

    await sm.archiveSession('root')
    expect(get('leaf').archivedByCascadeFrom).toBe('root')

    await sm.unarchiveSession('mid')
    expect(get('mid').isArchived).toBe(false)
    expect(get('mid').archivedByCascadeFrom).toBeUndefined()
    // leaf was cascaded from root, not from mid → stays archived
    expect(get('leaf').isArchived).toBe(true)
  })

  it('archives a processing descendant without aborting it', async () => {
    add('parent')
    const child = add('child', { parentSessionId: 'parent' })
    child.isProcessing = true

    await sm.archiveSession('parent')

    expect(get('child').isArchived).toBe(true)
    expect(get('child').isProcessing).toBe(true)
  })

  it('is cycle-safe and stays within the workspace', async () => {
    add('a', { parentSessionId: 'b' })
    add('b', { parentSessionId: 'a' })
    add('x', { parentSessionId: 'a' }, otherWs)

    await sm.archiveSession('a')

    expect(get('b').archivedByCascadeFrom).toBe('a')
    expect(get('a').isArchived).toBe(true)
    expect(get('x').isArchived).toBeFalsy()
  })
})
