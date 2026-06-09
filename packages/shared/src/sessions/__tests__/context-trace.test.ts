import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendContextTrace,
  buildPctOfCompaction,
  isContextTraceEnabled,
  type ContextTraceEntry,
} from '../context-trace.ts';

const TEST_DIR = join(import.meta.dir, '__test_context_trace__');
const SESSION_DIR = join(TEST_DIR, 'sessions', 'test-session');
const TRACE_PATH = join(SESSION_DIR, 'meta', 'context-trace.jsonl');

function entry(over: Partial<ContextTraceEntry> = {}): ContextTraceEntry {
  return {
    ts: '2026-06-03T12:00:00.000Z',
    sessionId: 'test-session',
    inputTokens: 70000,
    contextWindow: 200000,
    pctOfCompaction: buildPctOfCompaction(70000, 200000),
    replacement: true,
    sdkResume: false,
    compacted: false,
    ...over,
  };
}

describe('buildPctOfCompaction', () => {
  it('computes % of the 0.775 compaction threshold', () => {
    // 70k / (200k * 0.775) = 70000 / 155000 ≈ 45%
    expect(buildPctOfCompaction(70000, 200000)).toBe(45);
    // at the threshold itself → 100%
    expect(buildPctOfCompaction(155000, 200000)).toBe(100);
  });

  it('returns null when tokens or window are missing/zero', () => {
    expect(buildPctOfCompaction(null, 200000)).toBeNull();
    expect(buildPctOfCompaction(70000, null)).toBeNull();
    expect(buildPctOfCompaction(0, 200000)).toBeNull();
  });
});

describe('isContextTraceEnabled', () => {
  const prev = process.env.ORCHA_CONTEXT_TRACE;
  afterEach(() => {
    if (prev === undefined) delete process.env.ORCHA_CONTEXT_TRACE;
    else process.env.ORCHA_CONTEXT_TRACE = prev;
  });

  it('defaults on, opts out with 0/false', () => {
    delete process.env.ORCHA_CONTEXT_TRACE;
    expect(isContextTraceEnabled()).toBe(true);
    process.env.ORCHA_CONTEXT_TRACE = '0';
    expect(isContextTraceEnabled()).toBe(false);
    process.env.ORCHA_CONTEXT_TRACE = 'false';
    expect(isContextTraceEnabled()).toBe(false);
    process.env.ORCHA_CONTEXT_TRACE = '1';
    expect(isContextTraceEnabled()).toBe(true);
  });
});

describe('appendContextTrace', () => {
  beforeEach(() => {
    delete process.env.ORCHA_CONTEXT_TRACE;
    rmSync(TEST_DIR, { recursive: true, force: true });
  });
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('appends one JSON line per turn, creating meta/ as needed', () => {
    appendContextTrace(SESSION_DIR, entry({ inputTokens: 30000 }));
    appendContextTrace(SESSION_DIR, entry({ inputTokens: 60000 }));
    expect(existsSync(TRACE_PATH)).toBe(true);
    const lines = readFileSync(TRACE_PATH, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]!);
    expect(first.inputTokens).toBe(30000);
    expect(first.replacement).toBe(true);
    expect(JSON.parse(lines[1]!).inputTokens).toBe(60000);
  });

  it('writes nothing when disabled', () => {
    process.env.ORCHA_CONTEXT_TRACE = '0';
    appendContextTrace(SESSION_DIR, entry());
    expect(existsSync(TRACE_PATH)).toBe(false);
  });

  it('never throws on an unwritable path', () => {
    // /dev/null/... is not a directory — append must swallow the error
    expect(() => appendContextTrace('/dev/null/nope', entry())).not.toThrow();
  });
});
