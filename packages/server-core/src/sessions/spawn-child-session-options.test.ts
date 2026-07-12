import { describe, expect, it } from 'bun:test'
import { buildSpawnedChildSessionOptions, type SpawnParentSession } from './spawn-child-session-options.ts'

describe('buildSpawnedChildSessionOptions', () => {
  const parent: SpawnParentSession = {
    id: 'parent_session_1',
    llmConnection: 'anthropic-api',
    model: 'claude-sonnet-5',
    enabledSourceSlugs: ['gmail', 'linear'],
    permissionMode: 'allow-all',
    thinkingLevel: 'medium',
    labels: ['swarm'],
    workingDirectory: '/repo',
    projectId: 'proj_1',
  }

  // bg-child-routing-03: rerouted spawn links the child to the parent with notify-on-complete
  it('records the parent session id as the child parent', () => {
    const options = buildSpawnedChildSessionOptions({ prompt: 'do work' } as any, parent)
    expect(options.parentSessionId).toBe('parent_session_1')
  })

  it('marks the child to notify the parent on completion', () => {
    const options = buildSpawnedChildSessionOptions({ prompt: 'do work' } as any, parent)
    expect(options.notifyParentOnComplete).toBe(true)
  })

  // bg-child-visibility: hidden is opt-in per spawn, default false, and never
  // inherited from the parent — a hidden session's own children still show up
  // in the list unless they explicitly ask to be hidden too.
  it('defaults hidden to false when the request omits it', () => {
    const options = buildSpawnedChildSessionOptions({ prompt: 'do work' } as any, parent)
    expect(options.hidden).toBe(false)
  })

  it('hides the child when the request explicitly asks for it', () => {
    const options = buildSpawnedChildSessionOptions({ prompt: 'do work', hidden: true } as any, parent)
    expect(options.hidden).toBe(true)
  })

  it('does not inherit hidden from the parent session', () => {
    const hiddenParent: SpawnParentSession = { ...parent, ...({ hidden: true } as any) }
    const options = buildSpawnedChildSessionOptions({ prompt: 'do work' } as any, hiddenParent)
    expect(options.hidden).toBe(false)
  })

  // bg-child-routing-04: rerouted child inherits execution context from the parent
  describe.each([
    ['claude-sonnet-5', 'allow-all'],
    ['claude-haiku-4-5', 'ask'],
  ] as const)('model=%s permissionMode=%s', (model, permissionMode) => {
    const parentWithVariant: SpawnParentSession = { ...parent, model, permissionMode }

    it('uses the parent model when no override is given', () => {
      const options = buildSpawnedChildSessionOptions({}, parentWithVariant)
      expect(options.model).toBe(model)
    })

    it('uses the parent permission mode when no override is given', () => {
      const options = buildSpawnedChildSessionOptions({}, parentWithVariant)
      expect(options.permissionMode).toBe(permissionMode)
    })

    it("uses the parent session's working directory when no override is given", () => {
      const options = buildSpawnedChildSessionOptions({}, parentWithVariant)
      expect(options.workingDirectory).toBe(parentWithVariant.workingDirectory)
    })

    it("has the parent session's enabled sources when no override is given", () => {
      const options = buildSpawnedChildSessionOptions({}, parentWithVariant)
      expect(options.enabledSourceSlugs).toEqual(parentWithVariant.enabledSourceSlugs)
    })
  })

  it('inherits llmConnection, thinkingLevel, labels, and projectId from the parent when no override is given', () => {
    const options = buildSpawnedChildSessionOptions({}, parent)
    expect(options.llmConnection).toBe('anthropic-api')
    expect(options.thinkingLevel).toBe('medium')
    expect(options.labels).toEqual(['swarm'])
    expect(options.projectId).toBe('proj_1')
  })

  it('prefers an explicit request override over the parent default', () => {
    const options = buildSpawnedChildSessionOptions({
      model: 'gpt-5',
      permissionMode: 'safe',
      workingDirectory: '/other',
      enabledSourceSlugs: ['slack'],
      llmConnection: 'openai-api',
      thinkingLevel: 'high',
      labels: ['other'],
      projectId: 'proj_2',
    }, parent)

    expect(options.model).toBe('gpt-5')
    expect(options.permissionMode).toBe('safe')
    expect(options.workingDirectory).toBe('/other')
    expect(options.enabledSourceSlugs).toEqual(['slack'])
    expect(options.llmConnection).toBe('openai-api')
    expect(options.thinkingLevel).toBe('high')
    expect(options.labels).toEqual(['other'])
    expect(options.projectId).toBe('proj_2')
  })
})
