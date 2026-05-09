/**
 * Message Provider — Mastra-strict conversation tail builder.
 *
 * Step 3 of the observer-ledger-bridge plan. Reads the orcha-agents
 * `session.jsonl` and renders a compact `<conversation_tail>` block of the
 * last N messages. Used by `prompt-builder.ts` so the agent receives
 * recent conversation context WITHOUT the SDK re-loading the entire
 * resume-history into the API call.
 *
 * Pairs with: observations injection (system-prompt) for compacted older
 * turns + this tail (user message preamble) for the most-recent turns.
 *
 * Activation: gated by `ORCHA_STREAMING_MODE=1`. When off, this module is
 * a no-op and the SDK keeps its current resume-based behavior.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../../utils/debug.ts';
import { getSessionPath } from '../../sessions/storage.ts';

const log = createLogger('message-provider');

// ============================================================================
// Public API
// ============================================================================

export interface ConversationTailOptions {
  /** Maximum number of messages to include in the tail. */
  limit?: number;
  /** Maximum total characters across all tail entries (truncates oldest). */
  maxChars?: number;
  /** Per-message text truncation (avoids one giant tool-result blowing the budget). */
  maxCharsPerMessage?: number;
}

export interface ConversationTail {
  /** Pre-formatted block ready to inject into a prompt. */
  block: string;
  /** Number of messages actually included. */
  messageCount: number;
  /** Final size of the block in characters (proxy for tokens via /4). */
  charCount: number;
}

/** Default tail size — aligns with Mastra's "last 8-10 raw messages" guidance. */
const DEFAULT_TAIL_LIMIT = 10;
const DEFAULT_MAX_CHARS = 12_000; // ~3k tokens budget for the tail block
const DEFAULT_MAX_CHARS_PER_MESSAGE = 1500;

/**
 * Whether streaming-mode message-injection is currently active.
 * Read on each call so tests/users can toggle without process restart.
 */
export function isStreamingModeEnabled(): boolean {
  const v = process.env.ORCHA_STREAMING_MODE;
  return v === '1' || v === 'true';
}

/**
 * Build a `<conversation_tail>` block from the session's jsonl.
 * Returns null when the session file is missing, empty, or below the
 * minimum-injection threshold.
 *
 * Strategy A from the plan: tail rendered as a single text block in the
 * user message, NOT as separate SDKUserMessage turns. Simpler, robust,
 * survives mixed user/assistant/tool events.
 */
export function buildConversationTail(
  sessionId: string,
  workspaceRootPath: string,
  options: ConversationTailOptions = {},
): ConversationTail | null {
  const sessionDir = getSessionPath(workspaceRootPath, sessionId);
  const jsonlPath = join(sessionDir, 'session.jsonl');
  if (!existsSync(jsonlPath)) return null;

  const limit = options.limit ?? envLimit() ?? DEFAULT_TAIL_LIMIT;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const maxCharsPerMessage = options.maxCharsPerMessage ?? DEFAULT_MAX_CHARS_PER_MESSAGE;

  const entries = readTailEntries(jsonlPath, limit, maxCharsPerMessage);
  if (entries.length === 0) return null;

  // Render newest-last so the model reads chronologically.
  const lines: string[] = [];
  let accChars = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (accChars + e.length > maxChars) {
      // Drop OLDEST entries (start of array) when over budget.
      // Since we walk newest-last, this means truncating from the front
      // by stopping additions once budget is exhausted.
      break;
    }
    accChars += e.length;
    lines.unshift(e.text);
  }
  if (lines.length === 0) return null;

  const block = `<conversation_tail>
The following is a verbatim slice of the most recent ${lines.length} messages in this conversation. Use it as short-term memory; older history is summarized in <session_observations> if present.

${lines.join('\n\n')}
</conversation_tail>`;

  return { block, messageCount: lines.length, charCount: block.length };
}

// ============================================================================
// Internals
// ============================================================================

interface TailEntry {
  text: string;
  length: number;
}

function envLimit(): number | null {
  const raw = process.env.ORCHA_TAIL_BUFFER_MESSAGES;
  if (!raw) return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

/**
 * Read the last `limit` non-header lines from the jsonl and render each
 * into a compact one-block string. Skips synthetic/system lines.
 */
function readTailEntries(jsonlPath: string, limit: number, maxCharsPerMessage: number): TailEntry[] {
  let raw: string;
  try {
    raw = readFileSync(jsonlPath, 'utf-8');
  } catch (err) {
    log.debug('readTailEntries: read failed', err);
    return [];
  }

  const lines = raw.split('\n').filter(Boolean);
  if (lines.length <= 1) return [];

  // Skip header (line 0), walk from end backwards collecting up to `limit` items.
  const collected: TailEntry[] = [];
  for (let i = lines.length - 1; i >= 1 && collected.length < limit; i--) {
    const line = lines[i]!;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const rendered = renderMessage(parsed, maxCharsPerMessage);
    if (!rendered) continue;
    collected.push({ text: rendered, length: rendered.length });
  }
  // collected is newest-first; reverse so caller can iterate naturally.
  return collected.reverse();
}

/**
 * Render a single jsonl message into a tag-prefixed text snippet.
 * Returns null if the message has no usable content.
 */
function renderMessage(
  parsed: Record<string, unknown>,
  maxCharsPerMessage: number,
): string | null {
  const type = typeof parsed.type === 'string' ? parsed.type : 'unknown';
  const role = roleFromType(type);
  if (!role) return null;

  const text = extractText(parsed);
  if (!text) return null;

  const trimmed = text.length > maxCharsPerMessage
    ? `${text.slice(0, maxCharsPerMessage)}…[truncated ${text.length - maxCharsPerMessage}c]`
    : text;

  if (role === 'tool') {
    const toolName = typeof parsed.toolName === 'string' ? parsed.toolName : 'tool';
    return `[tool:${toolName}] ${trimmed}`;
  }
  return `[${role}] ${trimmed}`;
}

function roleFromType(type: string): 'user' | 'assistant' | 'tool' | null {
  switch (type) {
    case 'user':
      return 'user';
    case 'assistant':
      return 'assistant';
    case 'tool':
      return 'tool';
    // Skip non-conversational events: 'system', 'plan', 'error', etc.
    default:
      return null;
  }
}

function extractText(parsed: Record<string, unknown>): string {
  const c = parsed.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) {
    return c
      .map((b) => {
        const block = b as Record<string, unknown>;
        if (block.type === 'text' && typeof block.text === 'string') return block.text;
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  // Tool messages may have toolResult instead of content.
  const toolResult = parsed.toolResult;
  if (typeof toolResult === 'string') return toolResult.trim();
  return '';
}
