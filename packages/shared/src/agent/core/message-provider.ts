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
import { readWatermark } from '../../sessions/observation-watermark.ts';

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
  /**
   * True when the tail provably includes every message after the observation
   * watermark — i.e. no unobserved message is missing from this slice. When
   * false (no watermark yet, or none found), the tail is a plain recent-N
   * window and older unobserved messages are NOT represented anywhere. The
   * caller must treat `false` as "not safe to drop SDK history" under
   * streaming-replacement mode.
   */
  coversFromWatermark: boolean;
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
 * Cheap coverage check for the streaming-mode gate: returns true only when a
 * conversation tail can be built that provably includes every message after
 * the observation watermark. When false, the SDK's resume-history must NOT be
 * suppressed — older unobserved messages would otherwise be lost. Reasons for
 * false: no jsonl, no watermark yet, or the watermark id was compacted away.
 */
export function streamingTailCoversHistory(
  sessionId: string,
  workspaceRootPath: string,
): boolean {
  return buildConversationTail(sessionId, workspaceRootPath)?.coversFromWatermark ?? false;
}

/**
 * Build a `<conversation_tail>` block from the session's jsonl.
 * Returns null when the session file is missing, empty, or below the
 * minimum-injection threshold.
 *
 * Strategy A from the plan: tail rendered as a single text block in the
 * user message, NOT as separate SDKUserMessage turns. Simpler, robust,
 * survives mixed user/assistant/tool events.
 *
 * Watermark-aware coverage: when an observation watermark exists, the tail
 * ALWAYS includes every message after it (the not-yet-observed region), plus
 * a recent-message floor of `limit` messages. This is the correctness
 * guarantee that lets streaming-replacement drop SDK history safely — every
 * message is then represented either as an observation (≤ watermark) or
 * verbatim in this tail (> watermark). The total-char budget never drops an
 * unobserved message; it only trims the observed floor from the oldest end.
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

  // Resolve the watermark's raw-line index (exclusive lower bound of the
  // unobserved region). -1 = no watermark / not found → recent-N fallback.
  const watermarkId = readWatermark(sessionDir)?.lastObservedMessageId ?? null;

  const rendered = renderAllEntries(jsonlPath, maxCharsPerMessage, watermarkId);
  if (!rendered) return null;
  const { entries, watermarkRawIndex } = rendered;
  if (entries.length === 0) return null;

  const hasWatermark = watermarkRawIndex >= 0;

  // The unobserved region is the newest contiguous block (everything after
  // the watermark). The recent floor is the last `limit` rendered messages.
  // Both are suffixes of `entries`; the include-set is their union — the
  // wider suffix starting at `candidateStartIdx`. Entries older than that are
  // never sent (they're covered by observations).
  const floorStartIdx = Math.max(0, entries.length - limit);
  let firstUnobservedIdx = entries.length;
  if (hasWatermark) {
    for (let i = 0; i < entries.length; i++) {
      if (entries[i]!.rawIndex > watermarkRawIndex) {
        firstUnobservedIdx = i;
        break;
      }
    }
  }
  const candidateStartIdx = Math.min(floorStartIdx, firstUnobservedIdx);

  // Walk newest → oldest within the candidate suffix. Unobserved entries are
  // always kept (correctness). Observed entries yield to the char budget:
  // since unobserved is the newest suffix, once we cross into observed
  // territory everything older is also observed, so stopping is safe.
  const lines: string[] = [];
  let accChars = 0;
  for (let i = entries.length - 1; i >= candidateStartIdx; i--) {
    const e = entries[i]!;
    const isUnobserved = hasWatermark && e.rawIndex > watermarkRawIndex;
    if (accChars + e.length > maxChars && !isUnobserved) break;
    accChars += e.length;
    lines.unshift(e.text);
  }
  if (lines.length === 0) return null;

  const block = `<conversation_tail>
The following is a verbatim slice of the most recent ${lines.length} messages in this conversation. Use it as short-term memory; older history is summarized in <session_observations> if present.

${lines.join('\n\n')}
</conversation_tail>`;

  return {
    block,
    messageCount: lines.length,
    charCount: block.length,
    coversFromWatermark: hasWatermark,
  };
}

// ============================================================================
// Internals
// ============================================================================

interface TailEntry {
  text: string;
  length: number;
  /**
   * Index of this message within the message-lines array (header excluded,
   * 0-based). Used to compare against the watermark's position so unobserved
   * messages are never dropped for budget.
   */
  rawIndex: number;
}

function envLimit(): number | null {
  const raw = process.env.ORCHA_TAIL_BUFFER_MESSAGES;
  if (!raw) return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

/**
 * Read and render every conversational message line in the jsonl (oldest →
 * newest), tagging each with its raw-line index. Also resolves the watermark
 * message-id to its raw-line index so the caller can split observed from
 * unobserved. Skips synthetic/system lines and corrupted JSON.
 *
 * `watermarkRawIndex` is -1 when no watermark id is given or the id isn't
 * found in the file (e.g. compacted away) — both mean "treat as recent-N
 * fallback, coverage NOT guaranteed".
 */
function renderAllEntries(
  jsonlPath: string,
  maxCharsPerMessage: number,
  watermarkId: string | null,
): { entries: TailEntry[]; watermarkRawIndex: number } | null {
  let raw: string;
  try {
    raw = readFileSync(jsonlPath, 'utf-8');
  } catch (err) {
    log.debug('renderAllEntries: read failed', err);
    return null;
  }

  const lines = raw.split('\n').filter(Boolean);
  if (lines.length <= 1) return { entries: [], watermarkRawIndex: -1 };

  // Skip header (line 0). messageLines index = rawIndex.
  const messageLines = lines.slice(1);
  const entries: TailEntry[] = [];
  let watermarkRawIndex = -1;

  for (let i = 0; i < messageLines.length; i++) {
    const line = messageLines[i]!;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (watermarkId && watermarkRawIndex < 0 && parsed.id === watermarkId) {
      watermarkRawIndex = i;
    }
    const rendered = renderMessage(parsed, maxCharsPerMessage);
    if (!rendered) continue;
    entries.push({ text: rendered, length: rendered.length, rawIndex: i });
  }

  return { entries, watermarkRawIndex };
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
