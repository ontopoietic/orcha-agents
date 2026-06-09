import type { SessionToolContext, RecallToolArgs } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

export type RecallArgs = RecallToolArgs;

/**
 * Cross-session observational recall. Thin, backend-agnostic handler: it
 * validates the mode and delegates to the `ctx.recall` binding that the
 * backend injects (the file-based recall engine lives in the shared package).
 */
export async function handleRecall(
  ctx: SessionToolContext,
  args: RecallArgs,
): Promise<ToolResult> {
  if (!ctx.recall) {
    return errorResponse('recall is not available in this context.');
  }

  const mode = args.mode ?? 'search';

  if (mode === 'resolve' && (!args.sessionId || !args.messageId)) {
    return errorResponse('recall mode "resolve" requires both sessionId and messageId.');
  }
  if (mode === 'search' && args.anchorType && !args.anchorId) {
    return errorResponse('recall anchor filter requires anchorId alongside anchorType.');
  }

  try {
    const result = ctx.recall({ ...args, mode });
    return successResponse(JSON.stringify(result, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to recall: ${message}`);
  }
}
