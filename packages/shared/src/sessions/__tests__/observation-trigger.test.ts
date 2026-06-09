import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  maybeTriggerObserver,
  resetTriggerThrottle,
  estimateBacklogTokens,
  getObserverThresholdTokens,
} from '../observation-trigger.ts';

const TEST_DIR = join(import.meta.dir, '__test_observation_trigger__');
const SESSION_ID = 'test-session-trigger';
const SESSION_DIR = join(TEST_DIR, 'sessions', SESSION_ID);

function writeJsonl(messages: Array<{ id: string; content: string }>): void {
  mkdirSync(SESSION_DIR, { recursive: true });
  const lines = [JSON.stringify({ id: SESSION_ID })];
  for (const m of messages) lines.push(JSON.stringify(m));
  writeFileSync(join(SESSION_DIR, 'session.jsonl'), lines.join('\n') + '\n', 'utf-8');
}

function writeWatermark(lastId: string): void {
  mkdirSync(join(SESSION_DIR, 'meta'), { recursive: true });
  writeFileSync(
    join(SESSION_DIR, 'meta', 'observation-watermark.json'),
    JSON.stringify({ lastObservedMessageId: lastId }),
    'utf-8',
  );
}

describe('maybeTriggerObserver', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(SESSION_DIR, { recursive: true });
    resetTriggerThrottle();
    // Disable spawn side-effect by clearing CRAFT_APP_ROOT — the trigger
    // module silently returns when it can't find the script.
    delete process.env.CRAFT_APP_ROOT;
    delete process.env.ORCHA_OBSERVER_DISABLE_TRIGGER;
    delete process.env.ORCHA_OBSERVER_THRESHOLD_TOKENS;
    delete process.env.ORCHA_OBSERVER_MIN_INTERVAL_SECONDS;
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    resetTriggerThrottle();
  });

  it('returns false when session dir does not exist', () => {
    const result = maybeTriggerObserver(join(TEST_DIR, 'nonexistent'), SESSION_ID);
    expect(result.triggered).toBe(false);
    expect(result.reason).toContain('does not exist');
  });

  it('returns false when below threshold', () => {
    process.env.ORCHA_OBSERVER_THRESHOLD_TOKENS = '30000';
    writeJsonl([{ id: 'msg-1', content: 'short' }]);
    const result = maybeTriggerObserver(SESSION_DIR, SESSION_ID);
    expect(result.triggered).toBe(false);
    expect(result.reason).toContain('below threshold');
  });

  it('triggers when accumulated tokens exceed threshold (no watermark)', () => {
    // 1000 chars × 100 messages ≈ 100000 chars ≈ 25000 tokens. Set lower threshold.
    process.env.ORCHA_OBSERVER_THRESHOLD_TOKENS = '1000';
    const big = Array.from({ length: 50 }, (_, i) => ({
      id: `msg-${i}`,
      content: 'x'.repeat(500),
    }));
    writeJsonl(big);

    const result = maybeTriggerObserver(SESSION_DIR, SESSION_ID);
    expect(result.triggered).toBe(true);
    expect(result.tokensSinceWatermark).toBeGreaterThanOrEqual(1000);
  });

  it('counts only chars after the watermark message', () => {
    process.env.ORCHA_OBSERVER_THRESHOLD_TOKENS = '1000';
    process.env.ORCHA_OBSERVER_MIN_INTERVAL_SECONDS = '0';
    const big = Array.from({ length: 50 }, (_, i) => ({
      id: `msg-${i}`,
      content: 'x'.repeat(500),
    }));
    writeJsonl(big);

    // First run — full file
    const before = maybeTriggerObserver(SESSION_DIR, SESSION_ID);
    expect(before.triggered).toBe(true);

    // Set watermark very close to end → tokens-since should drop below threshold
    writeWatermark('msg-49');
    resetTriggerThrottle(SESSION_ID); // bypass cooldown for test

    const after = maybeTriggerObserver(SESSION_DIR, SESSION_ID);
    expect(after.triggered).toBe(false);
    expect(after.reason).toContain('below threshold');
  });

  it('throttles rapid-fire triggers', () => {
    process.env.ORCHA_OBSERVER_THRESHOLD_TOKENS = '100';
    process.env.ORCHA_OBSERVER_MIN_INTERVAL_SECONDS = '60';
    const big = Array.from({ length: 50 }, (_, i) => ({
      id: `msg-${i}`,
      content: 'x'.repeat(500),
    }));
    writeJsonl(big);

    const first = maybeTriggerObserver(SESSION_DIR, SESSION_ID);
    expect(first.triggered).toBe(true);

    const second = maybeTriggerObserver(SESSION_DIR, SESSION_ID);
    expect(second.triggered).toBe(false);
    expect(second.reason).toContain('throttled');
  });

  it('respects ORCHA_OBSERVER_DISABLE_TRIGGER', () => {
    process.env.ORCHA_OBSERVER_DISABLE_TRIGGER = '1';
    process.env.ORCHA_OBSERVER_THRESHOLD_TOKENS = '100';
    writeJsonl([{ id: 'msg-1', content: 'x'.repeat(10000) }]);
    const result = maybeTriggerObserver(SESSION_DIR, SESSION_ID);
    expect(result.triggered).toBe(false);
    expect(result.reason).toContain('disabled');
  });
});

describe('wake-trigger helpers', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(SESSION_DIR, { recursive: true });
    delete process.env.ORCHA_OBSERVER_THRESHOLD_TOKENS;
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    delete process.env.ORCHA_OBSERVER_THRESHOLD_TOKENS;
  });

  it('getObserverThresholdTokens returns default and respects env', () => {
    expect(getObserverThresholdTokens()).toBe(24_000);
    process.env.ORCHA_OBSERVER_THRESHOLD_TOKENS = '5000';
    expect(getObserverThresholdTokens()).toBe(5000);
  });

  it('estimateBacklogTokens is 0 for a missing session', () => {
    expect(estimateBacklogTokens(join(TEST_DIR, 'nonexistent'))).toBe(0);
  });

  it('estimateBacklogTokens counts only content after the watermark', () => {
    const big = Array.from({ length: 50 }, (_, i) => ({
      id: `msg-${i}`,
      content: 'x'.repeat(500),
    }));
    writeJsonl(big);
    const full = estimateBacklogTokens(SESSION_DIR);
    expect(full).toBeGreaterThan(1000);

    // Watermark near the end → backlog shrinks toward zero.
    writeWatermark('msg-49');
    const afterWm = estimateBacklogTokens(SESSION_DIR);
    expect(afterWm).toBeLessThan(full);
  });
});
