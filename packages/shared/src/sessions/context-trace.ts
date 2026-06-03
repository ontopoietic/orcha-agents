/**
 * Lightweight per-turn context trace.
 *
 * Appends one JSON line per completed turn to
 * `sessions/{id}/meta/context-trace.jsonl`, capturing the live context size
 * (`inputTokens`) and which path produced it — streaming-replacement (Mastra
 * Observational-Memory) vs. SDK resume — plus whether the SDK compacted that
 * turn.
 *
 * Why: the session JSONL header only keeps the *final* token snapshot. That
 * single point can't distinguish "the Observer held context flat" (Mastra
 * sawtooth) from "forking / SDK compaction trimmed it". This trace persists
 * the missing per-turn trajectory so the sawtooth-vs-climb question can be
 * answered from one clean run instead of inferred from a confounded endpoint.
 *
 * Opt out with `ORCHA_CONTEXT_TRACE=0`. Best-effort by design: a write failure
 * is logged at debug level and never propagates into the turn.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createLogger } from '../utils/debug.ts';

const log = createLogger('context-trace');

export interface ContextTraceEntry {
  /** ISO timestamp of turn completion. */
  ts: string;
  sessionId: string;
  /** Live context input tokens for this turn (cache-read + creation included). */
  inputTokens: number | null;
  /** Model context window for this turn. */
  contextWindow: number | null;
  /** inputTokens as % of the SDK compaction threshold (window × 0.775). */
  pctOfCompaction: number | null;
  /** Streaming-replacement (OM) path active this turn — SDK resume suppressed. */
  replacement: boolean;
  /** SDK resume path used this turn (auto-compaction can fire). */
  sdkResume: boolean;
  /** SDK emitted "Compacted Conversation" during this turn. */
  compacted: boolean;
}

/** Tracing is on by default; opt out with ORCHA_CONTEXT_TRACE=0 / false. */
export function isContextTraceEnabled(): boolean {
  const v = process.env.ORCHA_CONTEXT_TRACE;
  return v !== '0' && v !== 'false';
}

/** Compaction threshold ratio the SDK uses for a given context window. */
const COMPACTION_RATIO = 0.775;

export function buildPctOfCompaction(
  inputTokens: number | null,
  contextWindow: number | null,
): number | null {
  if (!inputTokens || !contextWindow) return null;
  return Math.round((inputTokens / (contextWindow * COMPACTION_RATIO)) * 100);
}

export function appendContextTrace(sessionDir: string, entry: ContextTraceEntry): void {
  if (!isContextTraceEnabled()) return;
  try {
    const path = join(sessionDir, 'meta', 'context-trace.jsonl');
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    log.debug(`append failed: ${(err as Error).message}`);
  }
}
