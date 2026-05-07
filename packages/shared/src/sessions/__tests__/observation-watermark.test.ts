import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import {
  readWatermark,
  writeWatermark,
  messagesSinceWatermark,
  readAllMessages,
  watermarkPath,
  type ObservationWatermark,
} from '../observation-watermark.ts';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ============================================================================
// Test fixtures
// ============================================================================

const TEST_DIR = join(import.meta.dir, '__test_watermark__');
const TEST_JSONL = join(TEST_DIR, 'session.jsonl');
const TEST_META = join(TEST_DIR, 'meta');

const sampleWatermark: ObservationWatermark = {
  sessionId: 'test-session-001',
  lastObservedMessageId: 'msg-003',
  lastObservedAt: '2026-05-07T12:00:00.000Z',
  observedCount: 3,
  lastSignalCount: 2,
};

function makeJsonl(messages: Array<Record<string, unknown>>): string {
  const header = JSON.stringify({
    id: 'test-session-001',
    workspaceRootPath: '~/test',
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    messageCount: messages.length,
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
  });
  const lines = messages.map(m => JSON.stringify(m));
  return [header, ...lines].join('\n') + '\n';
}

const sampleMessages = [
  { id: 'msg-001', content: 'Hello, let us start', type: 'user', timestamp: 1000 },
  { id: 'msg-002', content: 'Running Agent...', type: 'tool', timestamp: 1001, toolName: 'Agent' },
  { id: 'msg-003', content: 'I analyzed the codebase', type: 'assistant', timestamp: 1002 },
  { id: 'msg-004', content: 'Ich möchte pnpm verwenden', type: 'user', timestamp: 1003 },
  { id: 'msg-005', content: 'Warum funktioniert das nicht?', type: 'user', timestamp: 1004 },
  { id: 'msg-006', content: 'Let me check the error', type: 'assistant', timestamp: 1005 },
] as Array<{ id: string; content: string | unknown[]; type: string; timestamp: number; toolName?: string }>;

// ============================================================================
// Tests
// ============================================================================

describe('observation-watermark', () => {
  beforeEach(() => {
    // Clean up test dir
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_META, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  // --- Watermark Path ---

  describe('watermarkPath', () => {
    it('produces the expected meta subpath', () => {
      expect(watermarkPath('/sessions/abc')).toBe('/sessions/abc/meta/observation-watermark.json');
    });
  });

  // --- Read / Write Watermark ---

  describe('readWatermark', () => {
    it('returns null when no watermark file exists', () => {
      expect(readWatermark(TEST_DIR)).toBeNull();
    });

    it('reads a valid watermark', () => {
      writeWatermark(TEST_DIR, sampleWatermark);
      const read = readWatermark(TEST_DIR);
      expect(read).not.toBeNull();
      expect(read!.sessionId).toBe('test-session-001');
      expect(read!.lastObservedMessageId).toBe('msg-003');
      expect(read!.observedCount).toBe(3);
      expect(read!.lastSignalCount).toBe(2);
    });

    it('returns null for invalid watermark structure', () => {
      const filePath = join(TEST_META, 'observation-watermark.json');
      writeFileSync(filePath, JSON.stringify({ sessionId: 'x' }) + '\n', 'utf-8');
      expect(readWatermark(TEST_DIR)).toBeNull();
    });
  });

  describe('writeWatermark', () => {
    it('creates meta/ directory and writes watermark', () => {
      // Remove meta dir to test creation
      rmSync(TEST_META, { recursive: true });
      expect(existsSync(TEST_META)).toBe(false);

      writeWatermark(TEST_DIR, sampleWatermark);

      expect(existsSync(join(TEST_META, 'observation-watermark.json'))).toBe(true);
      // Re-read to verify roundtrip
      const read = readWatermark(TEST_DIR);
      expect(read).toEqual(sampleWatermark);
    });

    it('overwrites existing watermark', () => {
      writeWatermark(TEST_DIR, sampleWatermark);
      const updated: ObservationWatermark = {
        ...sampleWatermark,
        lastObservedMessageId: 'msg-006',
        observedCount: 6,
        lastSignalCount: 4,
      };
      writeWatermark(TEST_DIR, updated);
      expect(readWatermark(TEST_DIR)).toEqual(updated);
    });
  });

  // --- JSONL Message Extraction ---

  describe('messagesSinceWatermark', () => {
    it('returns messages after the watermark ID', () => {
      writeFileSync(TEST_JSONL, makeJsonl(sampleMessages), 'utf-8');
      const msgs = messagesSinceWatermark(TEST_JSONL, 'msg-003');
      expect(msgs.length).toBe(3); // msg-004, msg-005, msg-006
      expect(msgs[0]!.id).toBe('msg-004');
      expect(msgs[2]!.id).toBe('msg-006');
    });

    it('returns empty array when watermark is the last message', () => {
      writeFileSync(TEST_JSONL, makeJsonl(sampleMessages), 'utf-8');
      const msgs = messagesSinceWatermark(TEST_JSONL, 'msg-006');
      expect(msgs.length).toBe(0);
    });

    it('falls back to last 50 messages when watermark ID not found', () => {
      writeFileSync(TEST_JSONL, makeJsonl(sampleMessages), 'utf-8');
      const msgs = messagesSinceWatermark(TEST_JSONL, 'nonexistent-id');
      // 6 messages total, fallback is last 50 → all 6
      expect(msgs.length).toBe(6);
    });

    it('returns empty array for empty session', () => {
      writeFileSync(TEST_JSONL, makeJsonl([]), 'utf-8');
      const msgs = messagesSinceWatermark(TEST_JSONL, 'msg-001');
      expect(msgs.length).toBe(0);
    });

    it('extracts text content from string and array content', () => {
      const messages: Array<{ id: string; content: string | unknown[]; type: string; timestamp: number }> = [
        { id: 'msg-a', content: 'simple string', type: 'user', timestamp: 1 },
        { id: 'msg-b', content: [{ type: 'text', text: 'array content' }], type: 'assistant', timestamp: 2 },
      ];
      writeFileSync(TEST_JSONL, makeJsonl(messages), 'utf-8');
      const msgs = messagesSinceWatermark(TEST_JSONL, 'msg-a');
      expect(msgs.length).toBe(1);
      expect(msgs[0]!.content).toBe('array content');
    });
  });

  describe('readAllMessages', () => {
    it('reads all messages from session', () => {
      writeFileSync(TEST_JSONL, makeJsonl(sampleMessages), 'utf-8');
      const msgs = readAllMessages(TEST_JSONL);
      expect(msgs.length).toBe(6);
      expect(msgs[0]!.id).toBe('msg-001');
    });

    it('skips corrupted message lines', () => {
      const header = JSON.stringify({ id: 'test', workspaceRootPath: '~/test', createdAt: 1, lastUsedAt: 1 });
      const lines = [
        header,
        '{"id":"msg-1","content":"ok","type":"user","timestamp":1}',
        'CORRUPTED LINE {{{',
        '{"id":"msg-2","content":"still ok","type":"assistant","timestamp":2}',
      ];
      writeFileSync(TEST_JSONL, lines.join('\n') + '\n', 'utf-8');
      const msgs = readAllMessages(TEST_JSONL);
      expect(msgs.length).toBe(2);
    });

    it('returns empty for header-only file', () => {
      const header = JSON.stringify({ id: 'test', workspaceRootPath: '~/test', createdAt: 1, lastUsedAt: 1 });
      writeFileSync(TEST_JSONL, header + '\n', 'utf-8');
      expect(readAllMessages(TEST_JSONL).length).toBe(0);
    });
  });

  // --- Watermark update cycle ---

  describe('full watermark cycle', () => {
    it('supports multiple observation rounds', () => {
      writeFileSync(TEST_JSONL, makeJsonl(sampleMessages), 'utf-8');

      // Round 1: First observation (no watermark → last 50)
      const msgs1 = readAllMessages(TEST_JSONL).slice(-50);
      const wm1: ObservationWatermark = {
        sessionId: 'test-session-001',
        lastObservedMessageId: msgs1[msgs1.length - 1]!.id,
        lastObservedAt: new Date().toISOString(),
        observedCount: msgs1.length,
        lastSignalCount: 3,
      };
      writeWatermark(TEST_DIR, wm1);

      // Round 2: Add more messages, observe since watermark
      const moreMessages = [
        ...sampleMessages,
        { id: 'msg-007', content: 'New message', type: 'user', timestamp: 1006 },
        { id: 'msg-008', content: 'Response', type: 'assistant', timestamp: 1007 },
      ];
      writeFileSync(TEST_JSONL, makeJsonl(moreMessages), 'utf-8');

      const wm1read = readWatermark(TEST_DIR)!;
      const msgs2 = messagesSinceWatermark(TEST_JSONL, wm1read!.lastObservedMessageId);
      expect(msgs2.length).toBe(2);
      expect(msgs2[0]!.id).toBe('msg-007');
      expect(msgs2[1]!.id).toBe('msg-008');

      // Update watermark
      const wm2: ObservationWatermark = {
        ...wm1read,
        lastObservedMessageId: msgs2[msgs2.length - 1]!.id,
        lastObservedAt: new Date().toISOString(),
        observedCount: wm1read!.observedCount + msgs2.length,
        lastSignalCount: 1,
      };
      writeWatermark(TEST_DIR, wm2);

      // Round 3: No new messages
      const wm2read = readWatermark(TEST_DIR)!;
      const msgs3 = messagesSinceWatermark(TEST_JSONL, wm2read!.lastObservedMessageId);
      expect(msgs3.length).toBe(0);
    });
  });
});
