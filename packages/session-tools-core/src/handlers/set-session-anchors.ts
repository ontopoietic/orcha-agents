import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

/**
 * Single anchor entry shape accepted by the agent tool.
 * The handler stamps addedAt + addedBy='agent' before persisting.
 */
export interface SetSessionAnchorsAnchorInput {
  type: 'feature' | 'befund' | 'anliegen';
  id: string;
  title?: string;
}

export interface SetSessionAnchorsArgs {
  sessionId?: string;
  anchors: SetSessionAnchorsAnchorInput[];
}

const VALID_TYPES = new Set(['feature', 'befund', 'anliegen']);

export async function handleSetSessionAnchors(
  ctx: SessionToolContext,
  args: SetSessionAnchorsArgs
): Promise<ToolResult> {
  if (!ctx.setSessionAnchors) {
    return errorResponse('set_session_anchors is not available in this context.');
  }

  // Shape-validate each anchor and reject invalid entries up-front so the
  // agent gets a clear error rather than a silent drop.
  const rejected: string[] = [];
  const accepted: { type: 'feature' | 'befund' | 'anliegen'; id: string; title?: string }[] = [];
  for (const a of args.anchors ?? []) {
    if (!a || typeof a !== 'object') {
      rejected.push(`<non-object entry>`);
      continue;
    }
    if (!VALID_TYPES.has(a.type)) {
      rejected.push(`type "${String(a.type)}" (expected feature|befund|anliegen)`);
      continue;
    }
    if (typeof a.id !== 'string' || a.id.length === 0) {
      rejected.push(`empty id for type ${a.type}`);
      continue;
    }
    accepted.push({
      type: a.type,
      id: a.id,
      title: typeof a.title === 'string' && a.title.length > 0 ? a.title : undefined,
    });
  }

  if (rejected.length > 0 && accepted.length === 0) {
    return errorResponse(
      `All anchors rejected:\n${rejected.map((r) => `  - ${r}`).join('\n')}\n\n` +
      `Each anchor must be { type: 'feature'|'befund'|'anliegen', id: string, title?: string }.`
    );
  }

  try {
    const now = new Date().toISOString();
    const stamped = accepted.map((a) => ({ ...a, addedAt: now, addedBy: 'agent' as const }));
    await ctx.setSessionAnchors(args.sessionId, stamped);

    const target = args.sessionId ? `session ${args.sessionId}` : 'current session';
    const summary = accepted.length === 0
      ? `Anchors cleared on ${target}.`
      : `Anchors set on ${target}: ${accepted.map((a) => `${a.type}:${a.id}`).join(', ')}`;
    const warning = rejected.length > 0
      ? `\n\nWarning: ${rejected.length} entry(s) rejected: ${rejected.join('; ')}`
      : '';
    return successResponse(summary + warning);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to set anchors: ${message}`);
  }
}
