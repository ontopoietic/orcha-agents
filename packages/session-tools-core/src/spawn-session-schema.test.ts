// ORCHA §session-nesting: spawn_session `standalone` option (schema + description)
import { describe, expect, it } from 'bun:test'
import { SpawnSessionSchema, TOOL_DESCRIPTIONS } from './tool-defs.ts'

describe('spawn_session standalone option', () => {
  it('accepts an optional boolean standalone flag', () => {
    expect(SpawnSessionSchema.parse({ prompt: 'x', standalone: true }).standalone).toBe(true)
    expect(SpawnSessionSchema.parse({ prompt: 'x' }).standalone).toBeUndefined()
    expect(SpawnSessionSchema.safeParse({ prompt: 'x', standalone: 'yes' }).success).toBe(false)
  })

  it('description states nested-child default and explicit-request-only standalone', () => {
    const desc = TOOL_DESCRIPTIONS.spawn_session
    expect(desc).toContain('nested child')
    expect(desc).toContain('`standalone` to true ONLY when the user explicitly asks')
  })
})
