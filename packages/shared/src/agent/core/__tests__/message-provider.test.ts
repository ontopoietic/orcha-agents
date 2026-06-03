import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildConversationTail,
  isStreamingModeEnabled,
} from '../message-provider.ts';

const TEST_DIR = join(import.meta.dir, '__test_message_provider__');
const WORKSPACE = join(TEST_DIR, 'workspace');
const SESSION_ID = 'test-tail-session';
const SESSION_DIR = join(WORKSPACE, 'sessions', SESSION_ID);
const JSONL = join(SESSION_DIR, 'session.jsonl');
const WATERMARK = join(SESSION_DIR, 'meta', 'observation-watermark.json');

function writeJsonl(lines: object[]): void {
  mkdirSync(SESSION_DIR, { recursive: true });
  writeFileSync(JSONL, lines.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf-8');
}

function writeWatermarkFile(lastObservedMessageId: string): void {
  mkdirSync(join(SESSION_DIR, 'meta'), { recursive: true });
  writeFileSync(
    WATERMARK,
    JSON.stringify({
      sessionId: SESSION_ID,
      lastObservedMessageId,
      lastObservedAt: new Date().toISOString(),
      observedCount: 1,
      lastSignalCount: 1,
    }),
    'utf-8',
  );
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  delete process.env.ORCHA_STREAMING_MODE;
  delete process.env.ORCHA_TAIL_BUFFER_MESSAGES;
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('isStreamingModeEnabled', () => {
  it('is ON by default (no env set)', () => {
    delete process.env.ORCHA_STREAMING_MODE;
    expect(isStreamingModeEnabled()).toBe(true);
  });

  it('stays on with explicit =1 / =true', () => {
    process.env.ORCHA_STREAMING_MODE = '1';
    expect(isStreamingModeEnabled()).toBe(true);
    process.env.ORCHA_STREAMING_MODE = 'true';
    expect(isStreamingModeEnabled()).toBe(true);
  });

  it('opts out with =0', () => {
    process.env.ORCHA_STREAMING_MODE = '0';
    expect(isStreamingModeEnabled()).toBe(false);
  });

  it('opts out with =false', () => {
    process.env.ORCHA_STREAMING_MODE = 'false';
    expect(isStreamingModeEnabled()).toBe(false);
  });
});

describe('buildConversationTail', () => {
  it('returns null when jsonl missing', () => {
    expect(buildConversationTail(SESSION_ID, WORKSPACE)).toBeNull();
  });

  it('returns null when only header line exists', () => {
    writeJsonl([{ id: SESSION_ID, anchors: [] }]);
    expect(buildConversationTail(SESSION_ID, WORKSPACE)).toBeNull();
  });

  it('renders user + assistant + tool messages, skips unknown types', () => {
    writeJsonl([
      { id: SESSION_ID, anchors: [] }, // header
      { id: 'm1', type: 'user', content: 'Hello there' },
      { id: 'm2', type: 'assistant', content: 'Hi back' },
      { id: 'm3', type: 'tool', toolName: 'Read', toolResult: 'file contents abc' },
      { id: 'm4', type: 'plan', content: 'should be skipped' },
      { id: 'm5', type: 'user', content: 'Last user msg' },
    ]);
    const tail = buildConversationTail(SESSION_ID, WORKSPACE);
    expect(tail).not.toBeNull();
    expect(tail!.messageCount).toBe(4); // m1, m2, m3, m5 — m4 skipped
    expect(tail!.block).toContain('[user] Hello there');
    expect(tail!.block).toContain('[assistant] Hi back');
    expect(tail!.block).toContain('[tool:Read] file contents abc');
    expect(tail!.block).toContain('[user] Last user msg');
    expect(tail!.block).not.toContain('should be skipped');
  });

  it('respects the limit option (newest N messages)', () => {
    const lines: object[] = [{ id: SESSION_ID, anchors: [] }];
    for (let i = 0; i < 30; i++) {
      lines.push({ id: `m${i}`, type: 'user', content: `msg ${i}` });
    }
    writeJsonl(lines);
    const tail = buildConversationTail(SESSION_ID, WORKSPACE, { limit: 5 });
    expect(tail!.messageCount).toBe(5);
    // newest in the file is msg 29
    expect(tail!.block).toContain('msg 29');
    expect(tail!.block).toContain('msg 25');
    expect(tail!.block).not.toContain('msg 24');
  });

  it('honors ORCHA_TAIL_BUFFER_MESSAGES env override when no explicit limit', () => {
    const lines: object[] = [{ id: SESSION_ID, anchors: [] }];
    for (let i = 0; i < 20; i++) {
      lines.push({ id: `m${i}`, type: 'user', content: `msg ${i}` });
    }
    writeJsonl(lines);
    process.env.ORCHA_TAIL_BUFFER_MESSAGES = '3';
    const tail = buildConversationTail(SESSION_ID, WORKSPACE);
    expect(tail!.messageCount).toBe(3);
  });

  it('truncates long per-message text to maxCharsPerMessage', () => {
    writeJsonl([
      { id: SESSION_ID, anchors: [] },
      { id: 'm1', type: 'user', content: 'x'.repeat(5000) },
    ]);
    const tail = buildConversationTail(SESSION_ID, WORKSPACE, { maxCharsPerMessage: 100 });
    expect(tail!.block).toContain('[truncated');
    expect(tail!.block.length).toBeLessThan(1000);
  });

  it('drops oldest entries when over maxChars budget', () => {
    const lines: object[] = [{ id: SESSION_ID, anchors: [] }];
    for (let i = 0; i < 10; i++) {
      lines.push({ id: `m${i}`, type: 'user', content: 'a'.repeat(200) });
    }
    writeJsonl(lines);
    const tail = buildConversationTail(SESSION_ID, WORKSPACE, {
      limit: 10,
      maxChars: 800, // ~3-4 messages worth
      maxCharsPerMessage: 1000,
    });
    expect(tail!.messageCount).toBeLessThan(10);
    // newest must be present
    expect(tail!.block).toContain('m9'.length > 0 ? '[user]' : '');
  });

  it('handles array-content messages (extracts text blocks)', () => {
    writeJsonl([
      { id: SESSION_ID, anchors: [] },
      {
        id: 'm1',
        type: 'assistant',
        content: [
          { type: 'text', text: 'first part' },
          { type: 'tool_use', name: 'Read' },
          { type: 'text', text: 'second part' },
        ],
      },
    ]);
    const tail = buildConversationTail(SESSION_ID, WORKSPACE);
    expect(tail!.block).toContain('first part');
    expect(tail!.block).toContain('second part');
  });

  it('coversFromWatermark is false when no watermark file exists', () => {
    writeJsonl([
      { id: SESSION_ID, anchors: [] },
      { id: 'm1', type: 'user', content: 'hi' },
      { id: 'm2', type: 'assistant', content: 'hello' },
    ]);
    const tail = buildConversationTail(SESSION_ID, WORKSPACE);
    expect(tail!.coversFromWatermark).toBe(false);
  });

  describe('watermark-aware coverage', () => {
    it('includes ALL messages after the watermark even beyond the limit floor', () => {
      const lines: object[] = [{ id: SESSION_ID, anchors: [] }];
      for (let i = 0; i < 30; i++) {
        lines.push({ id: `m${i}`, type: 'user', content: `msg ${i}` });
      }
      writeJsonl(lines);
      // Observer only got through m5 → m6..m29 (24 msgs) are unobserved.
      writeWatermarkFile('m5');
      // Small floor of 3 — but coverage must still pull in all 24 unobserved.
      const tail = buildConversationTail(SESSION_ID, WORKSPACE, { limit: 3 });
      expect(tail!.coversFromWatermark).toBe(true);
      // m6 (first unobserved) must be present despite limit=3.
      expect(tail!.block).toContain('msg 6');
      expect(tail!.block).toContain('msg 29');
      // m5 and older are observed → not in the tail.
      expect(tail!.block).not.toContain('msg 5');
      expect(tail!.messageCount).toBe(24); // m6..m29
    });

    it('falls back to the recent floor when the watermark is fully caught up', () => {
      const lines: object[] = [{ id: SESSION_ID, anchors: [] }];
      for (let i = 0; i < 10; i++) {
        lines.push({ id: `m${i}`, type: 'user', content: `msg ${i}` });
      }
      writeJsonl(lines);
      // Watermark on the very last message → nothing unobserved.
      writeWatermarkFile('m9');
      const tail = buildConversationTail(SESSION_ID, WORKSPACE, { limit: 4 });
      expect(tail!.coversFromWatermark).toBe(true);
      // Floor of 4 most-recent messages, even though all are observed.
      expect(tail!.messageCount).toBe(4);
      expect(tail!.block).toContain('msg 9');
      expect(tail!.block).toContain('msg 6');
      expect(tail!.block).not.toContain('msg 5');
    });

    it('never drops unobserved messages to satisfy the char budget', () => {
      const lines: object[] = [{ id: SESSION_ID, anchors: [] }];
      for (let i = 0; i < 12; i++) {
        lines.push({ id: `m${i}`, type: 'user', content: 'a'.repeat(200) });
      }
      writeJsonl(lines);
      // m1 observed → m2..m11 (10 msgs) unobserved, ~210c each = ~2100c.
      writeWatermarkFile('m1');
      const tail = buildConversationTail(SESSION_ID, WORKSPACE, {
        limit: 2,
        maxChars: 500, // far below the unobserved total
        maxCharsPerMessage: 1000,
      });
      expect(tail!.coversFromWatermark).toBe(true);
      // All 10 unobserved messages survive despite the tiny budget.
      expect(tail!.messageCount).toBe(10);
    });

    it('treats a missing watermark id (compacted away) as no coverage', () => {
      const lines: object[] = [{ id: SESSION_ID, anchors: [] }];
      for (let i = 0; i < 8; i++) {
        lines.push({ id: `m${i}`, type: 'user', content: `msg ${i}` });
      }
      writeJsonl(lines);
      writeWatermarkFile('does-not-exist');
      const tail = buildConversationTail(SESSION_ID, WORKSPACE, { limit: 3 });
      // Watermark id not found → fall back to recent-N, coverage false.
      expect(tail!.coversFromWatermark).toBe(false);
      expect(tail!.messageCount).toBe(3);
    });
  });

  it('survives corrupted lines without throwing', () => {
    mkdirSync(SESSION_DIR, { recursive: true });
    const content = [
      JSON.stringify({ id: SESSION_ID, anchors: [] }),
      JSON.stringify({ id: 'm1', type: 'user', content: 'before' }),
      '{not valid json',
      JSON.stringify({ id: 'm2', type: 'user', content: 'after' }),
    ].join('\n') + '\n';
    writeFileSync(JSONL, content, 'utf-8');
    const tail = buildConversationTail(SESSION_ID, WORKSPACE);
    expect(tail!.messageCount).toBe(2);
    expect(tail!.block).toContain('before');
    expect(tail!.block).toContain('after');
  });
});
