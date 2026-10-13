import { describe, it, expect } from 'bun:test'
import { buildMcpSourceToolCallbacks, type McpSourcePool } from './mcp-source-tool-callbacks'

function fakePool(name: string, calls: string[]): McpSourcePool {
  return {
    listResources: async (slug) => {
      calls.push(`${name}.listResources(${slug})`)
      return {
        resources: [{
          uri: 'liza://guides/knowledge-authoring',
          name: 'knowledge-authoring',
          mimeType: 'text/markdown',
          icons: [{ src: 'https://liza.example/icon.png' }],
          annotations: { priority: 1 },
          _meta: { internal: true },
        }],
        resourceTemplates: [{ uriTemplate: 'liza://guides/{name}', name: 'guide', _meta: { internal: true } }],
        truncated: false,
      }
    },
    readResource: async (slug, uri) => {
      calls.push(`${name}.readResource(${slug}, ${uri})`)
      return `${name}: # Guide`
    },
    listPrompts: async (slug) => {
      calls.push(`${name}.listPrompts(${slug})`)
      return { prompts: [{ name: 'write-entry', arguments: [{ name: 'topic', required: true }], icons: [] }], truncated: true }
    },
    getPrompt: async (slug, prompt, args) => {
      calls.push(`${name}.getPrompt(${slug}, ${prompt}, ${JSON.stringify(args)})`)
      return '[user]\nWrite'
    },
  }
}

describe('MCP source tool callbacks', () => {
  it('only reaches sources enabled in the session', async () => {
    const calls: string[] = []
    let enabled: string[] | undefined = ['liza']
    const callbacks = buildMcpSourceToolCallbacks({ getPool: () => fakePool('pool', calls), getEnabledSourceSlugs: () => enabled })

    await expect(callbacks.readResource('github', 'x://y')).rejects.toThrow('Source "github" is not enabled in this session (enabled: liza).')
    enabled = undefined
    await expect(callbacks.getPrompt('liza', 'p')).rejects.toThrow('(no sources are enabled)')
    expect(calls).toEqual([])
  })

  it('reads the pool at call time, so a recreated agent pool is used', async () => {
    const calls: string[] = []
    let pool: McpSourcePool | undefined
    const callbacks = buildMcpSourceToolCallbacks({ getPool: () => pool, getEnabledSourceSlugs: () => ['liza'] })

    await expect(callbacks.listPrompts('liza')).rejects.toThrow('Source "liza" is not connected yet.')
    pool = fakePool('first', calls)
    expect(await callbacks.readResource('liza', 'liza://guides/a')).toBe('first: # Guide')
    pool = fakePool('second', calls)
    expect(await callbacks.readResource('liza', 'liza://guides/a')).toBe('second: # Guide')
    expect(calls).toEqual(['first.readResource(liza, liza://guides/a)', 'second.readResource(liza, liza://guides/a)'])
  })

  it('maps listings to the plain tool shapes, dropping icons, annotations and _meta', async () => {
    const calls: string[] = []
    const callbacks = buildMcpSourceToolCallbacks({ getPool: () => fakePool('pool', calls), getEnabledSourceSlugs: () => ['liza'] })

    const resources = await callbacks.listResources('liza')
    expect(JSON.parse(JSON.stringify(resources))).toEqual({
      resources: [{ uri: 'liza://guides/knowledge-authoring', name: 'knowledge-authoring', mimeType: 'text/markdown' }],
      resourceTemplates: [{ uriTemplate: 'liza://guides/{name}', name: 'guide' }],
    })

    const prompts = await callbacks.listPrompts('liza')
    expect(JSON.parse(JSON.stringify(prompts))).toEqual({
      prompts: [{ name: 'write-entry', arguments: [{ name: 'topic', required: true }] }],
      truncated: true,
    })

    expect(await callbacks.getPrompt('liza', 'write-entry', { topic: 'MCP' })).toBe('[user]\nWrite')
    expect(calls.at(-1)).toBe('pool.getPrompt(liza, write-entry, {"topic":"MCP"})')
  })
})
