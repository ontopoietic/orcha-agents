/**
 * Observation Watermark — tracks last-observed message per session
 *
 * Before SDK compaction drops older messages, the observer reads new
 * messages since the watermark and extracts structured signals into
 * the ledger. The watermark prevents double-processing.
 *
 * Persisted at: sessions/{id}/meta/observation-watermark.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createLogger } from '../utils/debug.ts';

const log = createLogger('observation-watermark');

// ============================================================================
// Types
// ============================================================================

export interface ObservationWatermark {
  /** Session this watermark belongs to */
  sessionId: string;
  /** Last message ID that was observed (exclusive lower bound) */
  lastObservedMessageId: string;
  /** ISO timestamp of last observation run */
  lastObservedAt: string;
  /** Total messages observed across all runs */
  observedCount: number;
  /** Number of signals written in the last observation run */
  lastSignalCount: number;
}

/**
 * Shape of a single observation signal as written to data/observations.json
 * by orcha-observe.ts. Mirrors the RawSignal layout but exposes only the
 * fields the UI viewer needs.
 */
export interface ObservationSignal {
  id: string;
  createdAt: string;
  source: string;
  summary: string;
  status: string;
  /**
   * Mastra priority taxonomy: 'high' | 'medium' | 'low'. Legacy persisted
   * files may carry 'pivotal' | 'question' | 'context' — normalize with
   * `normalizeLegacySalience` from observation-markdown-parser.
   */
  salience?: 'high' | 'medium' | 'low' | string;
  /** True when the source bullet was a ✅ Completed observation. */
  completed?: boolean;
  anchorRefs?: unknown[];
  conversation?: {
    sessionId?: string;
    messageRange?: { from?: string; to?: string };
    excerpt?: string;
    actor?: 'user' | 'agent' | 'mixed' | string;
  };
}

/**
 * Simplified message shape for observation extraction.
 * Only the fields the observer cares about.
 */
export interface ObservableMessage {
  id: string;
  content: string;
  timestamp: number;
  type: 'user' | 'assistant' | 'tool' | 'system' | 'error' | 'plan';
  toolName?: string;
}

// ============================================================================
// Watermark Persistence
// ============================================================================

/**
 * Get the default watermark file path for a session directory.
 */
export function watermarkPath(sessionDir: string): string {
  return join(sessionDir, 'meta', 'observation-watermark.json');
}

/**
 * Read the observation watermark for a session.
 * Returns null if no watermark exists (first observation run).
 */
export function readWatermark(sessionDir: string): ObservationWatermark | null {
  const filePath = watermarkPath(sessionDir);
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as ObservationWatermark;
    // Basic validation
    if (!parsed.sessionId || !parsed.lastObservedMessageId || !parsed.lastObservedAt) {
      log.debug('[watermark] Invalid watermark structure, ignoring:', filePath);
      return null;
    }
    return parsed;
  } catch (err) {
    log.debug('[watermark] Failed to read:', filePath, err);
    return null;
  }
}

/**
 * Write the observation watermark for a session.
 * Creates the meta/ directory if it doesn't exist.
 */
export function writeWatermark(sessionDir: string, wm: ObservationWatermark): void {
  const filePath = watermarkPath(sessionDir);
  const dir = dirname(filePath);
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(filePath, JSON.stringify(wm, null, 2) + '\n', 'utf-8');
    log.debug(`[watermark] Written: sessionId=${wm.sessionId} lastMsg=${wm.lastObservedMessageId} count=${wm.observedCount}`);
  } catch (err) {
    log.error('[watermark] Failed to write:', filePath, err);
    throw err;
  }
}

// ============================================================================
// JSONL Message Extraction
// ============================================================================

/**
 * Extract messages from a session.jsonl file since a given message ID.
 *
 * Uses streaming line-by-line reading to avoid loading the entire file
 * into memory for large sessions (800+ messages).
 *
 * @param sessionJsonlPath - Path to session.jsonl
 * @param sinceMessageId - Exclusive lower bound. Messages with this ID
 *                         and everything before it are skipped.
 * @returns ObservableMessages after the watermark, or all messages if
 *          the watermark ID wasn't found (fallback for edge cases).
 */
export function messagesSinceWatermark(
  sessionJsonlPath: string,
  sinceMessageId: string,
): ObservableMessage[] {
  const content = readFileSync(sessionJsonlPath, 'utf-8');
  const lines = content.split('\n').filter(Boolean);

  if (lines.length === 0) return [];

  // Skip header line (line 0), find watermark position
  const messageLines = lines.slice(1);
  let watermarkIndex = -1;

  for (let i = 0; i < messageLines.length; i++) {
    try {
      const line = messageLines[i];
      if (!line) continue;
      const parsed = JSON.parse(line);
      if (parsed.id === sinceMessageId) {
        watermarkIndex = i;
        break;
      }
    } catch {
      // Skip corrupted lines
    }
  }

  // If watermark not found, return last 50 messages (safe fallback)
  const startLine = watermarkIndex >= 0 ? watermarkIndex + 1 : Math.max(0, messageLines.length - 50);
  const relevantLines = messageLines.slice(startLine);

  const messages: ObservableMessage[] = [];
  for (const line of relevantLines) {
    try {
      const parsed = JSON.parse(line);
      messages.push(toObservableMessage(parsed));
    } catch {
      // Skip corrupted lines
    }
  }

  return messages;
}

/**
 * Extract ALL messages from a session.jsonl file.
 * Used when no watermark exists yet (first observation run).
 */
export function readAllMessages(sessionJsonlPath: string): ObservableMessage[] {
  const content = readFileSync(sessionJsonlPath, 'utf-8');
  const lines = content.split('\n').filter(Boolean);

  if (lines.length === 0) return [];

  // Skip header line
  const messages: ObservableMessage[] = [];
  for (const line of lines.slice(1)) {
    try {
      const parsed = JSON.parse(line);
      messages.push(toObservableMessage(parsed));
    } catch {
      // Skip corrupted lines
    }
  }

  return messages;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Convert a raw JSONL message object to an ObservableMessage.
 * Extracts only the fields needed for observation extraction.
 */
function toObservableMessage(parsed: Record<string, unknown>): ObservableMessage {
  return {
    id: parsed.id as string,
    content: extractTextContent(parsed),
    timestamp: parsed.timestamp as number,
    type: (parsed.type as ObservableMessage['type']) ?? 'assistant',
    toolName: parsed.toolName as string | undefined,
  };
}

/**
 * Extract readable text content from a message.
 * Handles both simple string content and complex content arrays.
 */
function extractTextContent(parsed: Record<string, unknown>): string {
  const content = parsed.content;

  // Simple string content
  if (typeof content === 'string') return content;

  // Array of content blocks (Claude SDK format)
  if (Array.isArray(content)) {
    return content
      .filter((block: unknown) => {
        const b = block as Record<string, unknown>;
        return b.type === 'text' && typeof b.text === 'string';
      })
      .map((block: unknown) => (block as { text: string }).text)
      .join('\n');
  }

  return '';
}
