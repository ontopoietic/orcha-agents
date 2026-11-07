import { describe, expect, it } from 'bun:test'
import { spawnedSessionOptions, type SpawnParent } from './spawn-options.ts'
import { isNestedSpawn, orchaSpawnOverrides } from './spawn-child-session-options.ts'

// ORCHA §bg-child-sessions / §session-nesting — fork overrides layered over
// upstream's spawnedSessionOptions(), exactly as SessionManager.onSpawnSession does.
const parent: SpawnParent = {
  id: 'parent_session_1',
  llmConnection: 'anthropic-api',
  model: 'claude-sonnet-5',
  enabledSourceSlugs: ['gmail'],
  labels: ['work'],
  workingDirectory: '/repo',
  projectId: 'proj_1',
}

function build(request: { standalone?: boolean; hidden?: boolean } = {}) {
  return { ...spawnedSessionOptions({}, parent), ...orchaSpawnOverrides(request) }
}

describe('orchaSpawnOverrides', () => {
  // bg-child-routing-03
  it('nested child keeps the parent link and notifies the parent on completion', () => {
    const options = build()
    expect(options.parentSessionId).toBe('parent_session_1')
    expect(options.notifyParentOnComplete).toBe(true)
  })

  it('standalone drops the parent link and the completion notification', () => {
    const options = build({ standalone: true })
    expect(options.parentSessionId).toBeUndefined()
    expect(options.notifyParentOnComplete).toBe(false)
  })

  it('standalone still inherits the parent settings', () => {
    const options = build({ standalone: true })
    expect(options.llmConnection).toBe('anthropic-api')
    expect(options.model).toBe('claude-sonnet-5')
    expect(options.workingDirectory).toBe('/repo')
    expect(options.projectId).toBe('proj_1')
  })

  // bg-child-visibility: hidden is opt-in per spawn, default false
  it('hidden defaults to false and is opt-in', () => {
    expect(build().hidden).toBe(false)
    expect(build({ hidden: true }).hidden).toBe(true)
  })

  it('isNestedSpawn is true unless standalone is set', () => {
    expect(isNestedSpawn({})).toBe(true)
    expect(isNestedSpawn({ standalone: false })).toBe(true)
    expect(isNestedSpawn({ standalone: true })).toBe(false)
  })
})
