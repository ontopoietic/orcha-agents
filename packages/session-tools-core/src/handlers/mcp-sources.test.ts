import { describe, it, expect } from 'bun:test';
import {
  handleSourceListResources,
  handleSourceReadResource,
  handleSourceListPrompts,
  handleSourceGetPrompt,
} from './mcp-sources.ts';
import type { SessionToolContext, McpSourceToolCallbacks } from '../context.ts';

function createCtx(overrides?: Partial<McpSourceToolCallbacks>): {
  ctx: SessionToolContext;
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = (method: string, ...args: unknown[]) => calls.push({ method, args });
  const mcpSources: McpSourceToolCallbacks = {
    listResources: async (slug) => {
      record('listResources', slug);
      return {
        resources: [{ uri: 'liza://guides/knowledge-authoring', name: 'knowledge-authoring', mimeType: 'text/markdown' }],
        resourceTemplates: [{ uriTemplate: 'liza://guides/{name}', name: 'guide' }],
      };
    },
    readResource: async (slug, uri) => { record('readResource', slug, uri); return '# Knowledge authoring'; },
    listPrompts: async (slug) => {
      record('listPrompts', slug);
      return { prompts: [{ name: 'write-entry', arguments: [{ name: 'topic', required: true }] }], truncated: true };
    },
    getPrompt: async (slug, name, args) => { record('getPrompt', slug, name, args); return '[user]\nWrite an entry about MCP.'; },
    ...overrides,
  };
  return { ctx: { mcpSources } as unknown as SessionToolContext, calls };
}

const text = (result: { content: Array<{ text: string }> }) => result.content[0]!.text;

describe('MCP source resources & prompts handlers', () => {
  it('all handlers degrade gracefully without the mcpSources callbacks', async () => {
    const ctx = {} as unknown as SessionToolContext;
    for (const result of [
      await handleSourceListResources(ctx, { sourceSlug: 'liza' }),
      await handleSourceReadResource(ctx, { sourceSlug: 'liza', uri: 'liza://x' }),
      await handleSourceListPrompts(ctx, { sourceSlug: 'liza' }),
      await handleSourceGetPrompt(ctx, { sourceSlug: 'liza', name: 'p' }),
    ]) {
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('not available');
    }
  });

  it('validates required arguments before calling the backend', async () => {
    const { ctx, calls } = createCtx();
    expect(text(await handleSourceListResources(ctx, { sourceSlug: ' ' }))).toContain('sourceSlug is required');
    expect(text(await handleSourceReadResource(ctx, { sourceSlug: 'liza', uri: '' }))).toContain('uri is required');
    expect(text(await handleSourceGetPrompt(ctx, { sourceSlug: 'liza', name: '' }))).toContain('name is required');
    expect(calls).toHaveLength(0);
  });

  it('source_list_resources summarizes, then lists resources and templates', async () => {
    const { ctx, calls } = createCtx();
    const result = await handleSourceListResources(ctx, { sourceSlug: ' liza ' });
    expect(result.isError).toBe(false);
    expect(calls[0]).toEqual({ method: 'listResources', args: ['liza'] });
    const [summary, json] = text(result).split('\n\n');
    expect(summary).toBe('1 resource and 1 resource template from "liza". Read one with source_read_resource (for a template, fill in its {placeholders} to form the uri).');
    expect(JSON.parse(json!).resources[0].uri).toBe('liza://guides/knowledge-authoring');
  });

  it('source_list_resources and source_list_prompts say so when a source publishes nothing', async () => {
    const { ctx } = createCtx({
      listResources: async () => ({ resources: [], resourceTemplates: [] }),
      listPrompts: async () => ({ prompts: [] }),
    });
    expect(text(await handleSourceListResources(ctx, { sourceSlug: 'liza' }))).toBe('Source "liza" publishes no resources.');
    expect(text(await handleSourceListPrompts(ctx, { sourceSlug: 'liza' }))).toBe('Source "liza" publishes no prompts.');
  });

  it('source_list_prompts reports truncation and the prompts with their arguments', async () => {
    const { ctx } = createCtx();
    const output = text(await handleSourceListPrompts(ctx, { sourceSlug: 'liza' }));
    expect(output.startsWith('1 prompt from "liza" (the server has more; the list stops at the page limit). Get one with source_get_prompt')).toBe(true);
    expect(JSON.parse(output.split('\n\n')[1]!).prompts[0].arguments).toEqual([{ name: 'topic', required: true }]);
  });

  it('source_read_resource and source_get_prompt return the backend text', async () => {
    const { ctx, calls } = createCtx();
    expect(text(await handleSourceReadResource(ctx, { sourceSlug: 'liza', uri: 'liza://guides/knowledge-authoring' }))).toBe('# Knowledge authoring');
    expect(text(await handleSourceGetPrompt(ctx, { sourceSlug: 'liza', name: 'write-entry', arguments: { topic: 'MCP' } })))
      .toBe('[user]\nWrite an entry about MCP.');
    expect(calls).toEqual([
      { method: 'readResource', args: ['liza', 'liza://guides/knowledge-authoring'] },
      { method: 'getPrompt', args: ['liza', 'write-entry', { topic: 'MCP' }] },
    ]);
  });

  it('wraps backend errors such as an unknown source', async () => {
    const notEnabled = async () => { throw new Error('Source "nope" is not enabled in this session (enabled: liza).'); };
    const { ctx } = createCtx({ listResources: notEnabled, readResource: notEnabled, listPrompts: notEnabled, getPrompt: notEnabled });

    const list = await handleSourceListResources(ctx, { sourceSlug: 'nope' });
    expect(list.isError).toBe(true);
    expect(text(list)).toBe('[ERROR] Failed to list resources: Source "nope" is not enabled in this session (enabled: liza).');
    expect(text(await handleSourceReadResource(ctx, { sourceSlug: 'nope', uri: 'x://y' }))).toContain('Failed to read x://y: Source "nope" is not enabled');
    expect(text(await handleSourceListPrompts(ctx, { sourceSlug: 'nope' }))).toContain('Failed to list prompts');
    expect(text(await handleSourceGetPrompt(ctx, { sourceSlug: 'nope', name: 'p' }))).toContain('Failed to get prompt "p"');
  });
});
