import { describe, it, expect } from 'bun:test';
import { handleProjectMemoryAppend } from './project-memory.ts';
import type { SessionToolContext, ProjectMemoryAppendInput } from '../context.ts';

function createCtx(append?: (input: ProjectMemoryAppendInput) => Promise<{ path: string; heading: string; bytesAppended: number }>): {
  ctx: SessionToolContext;
  calls: ProjectMemoryAppendInput[];
} {
  const calls: ProjectMemoryAppendInput[] = [];
  const ctx = {
    appendProjectMemory: async (input: ProjectMemoryAppendInput) => {
      calls.push(input);
      return append
        ? append(input)
        : { path: '/ws/projects/liza/MEMORY.md', heading: '2026-10-11T22:00:00.000Z — Explore', bytesAppended: 64 };
    },
  } as unknown as SessionToolContext;
  return { ctx, calls };
}

describe('handleProjectMemoryAppend', () => {
  it('appends the note and names the file and heading', async () => {
    const { ctx, calls } = createCtx();
    const result = await handleProjectMemoryAppend(ctx, { note: 'The consent page needs a JS click.' });

    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([{ note: 'The consent page needs a JS click.' }]);
    expect(result.content[0].text).toBe('Added to /ws/projects/liza/MEMORY.md under "## 2026-10-11T22:00:00.000Z — Explore".');
  });

  it('rejects an empty note without writing', async () => {
    const { ctx, calls } = createCtx();
    const result = await handleProjectMemoryAppend(ctx, { note: '  \n' });

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('reports sessions without a project', async () => {
    const { ctx } = createCtx(async () => { throw new Error('This session is not bound to a project.'); });
    const result = await handleProjectMemoryAppend(ctx, { note: 'x' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to add the note: This session is not bound to a project.');
  });

  it('errors when the host does not provide the callback', async () => {
    const result = await handleProjectMemoryAppend({} as SessionToolContext, { note: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not available');
  });
});
