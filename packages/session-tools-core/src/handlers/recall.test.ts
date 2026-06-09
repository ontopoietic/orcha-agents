import { describe, it, expect } from 'bun:test';
import { handleRecall } from './recall.ts';
import type { SessionToolContext, RecallToolArgs, RecallToolResult } from '../context.ts';

/** Minimal ctx with a recording `recall` binding. */
function createCtx(impl?: (args: RecallToolArgs) => RecallToolResult) {
  const calls: RecallToolArgs[] = [];
  const ctx = {
    sessionId: 'test-session',
    workspacePath: '/tmp/ws',
    recall: (args: RecallToolArgs): RecallToolResult => {
      calls.push(args);
      return impl ? impl(args) : { mode: args.mode ?? 'search', hits: [] };
    },
  } as unknown as SessionToolContext;
  return { ctx, calls };
}

describe('handleRecall', () => {
  it('returns not-available when the binding is missing', async () => {
    const ctx = { sessionId: 's', workspacePath: '/tmp/ws' } as unknown as SessionToolContext;
    const res = await handleRecall(ctx, {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('not available');
  });

  it('defaults to search mode and forwards args to the binding', async () => {
    const { ctx, calls } = createCtx((a) => ({ mode: 'search', hits: [{ sessionId: 'x' }], ...a }));
    const res = await handleRecall(ctx, { text: 'reflector threshold' });
    expect(res.isError).toBe(false);
    expect(calls[0]!.mode).toBe('search');
    expect(calls[0]!.text).toBe('reflector threshold');
    expect(JSON.parse(res.content[0]!.text).hits).toHaveLength(1);
  });

  it('rejects resolve mode without sessionId + messageId (binding not called)', async () => {
    const { ctx, calls } = createCtx();
    const res = await handleRecall(ctx, { mode: 'resolve', sessionId: 'only-session' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('requires both sessionId and messageId');
    expect(calls).toHaveLength(0);
  });

  it('rejects anchorType without anchorId (binding not called)', async () => {
    const { ctx, calls } = createCtx();
    const res = await handleRecall(ctx, { anchorType: 'feature' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('requires anchorId');
    expect(calls).toHaveLength(0);
  });

  it('passes a valid resolve request through to the binding', async () => {
    const { ctx, calls } = createCtx((a) => ({ mode: 'resolve', resolved: { sessionId: a.sessionId } }));
    const res = await handleRecall(ctx, { mode: 'resolve', sessionId: 's1', messageId: 'msg-1' });
    expect(res.isError).toBe(false);
    expect(calls[0]!.mode).toBe('resolve');
    expect(JSON.parse(res.content[0]!.text).resolved.sessionId).toBe('s1');
  });

  it('surfaces a thrown binding error as an error response', async () => {
    const ctx = {
      sessionId: 's',
      workspacePath: '/tmp/ws',
      recall: () => {
        throw new Error('disk gone');
      },
    } as unknown as SessionToolContext;
    const res = await handleRecall(ctx, { text: 'x' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('disk gone');
  });
});
