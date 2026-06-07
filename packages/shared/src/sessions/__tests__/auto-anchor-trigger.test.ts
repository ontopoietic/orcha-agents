import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  maybeTriggerAutoAnchor,
  countUntaggedObservations,
  resetAutoAnchorTriggerThrottle,
} from '../auto-anchor-trigger.ts';

const TEST_DIR = join(import.meta.dir, '__test_autoanchor_trigger__');
const SESSION_ID = 'test-autoanchor-session';
const SESSION_DIR = join(TEST_DIR, 'sessions', SESSION_ID);
const DATA_DIR = join(SESSION_DIR, 'data');
const SIDECAR = join(DATA_DIR, 'observations-evidence.json');

/** Write a sidecar with `tagged` anchored entries and `untagged` bare entries. */
function writeSidecar(tagged: number, untagged: number): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < tagged; i++) {
    obj[`t${i}`] = {
      fullMessageId: `msg-t${i}`,
      anchorRefs: [{ type: 'feature', id: `feat-${i}`, title: 'X', addedAt: '2026-01-01T00:00:00Z', addedBy: 'user' }],
    };
  }
  for (let i = 0; i < untagged; i++) {
    obj[`u${i}`] = { fullMessageId: `msg-u${i}` };
  }
  writeFileSync(SIDECAR, JSON.stringify(obj), 'utf-8');
}

describe('auto-anchor-trigger', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(DATA_DIR, { recursive: true });
    resetAutoAnchorTriggerThrottle();
    delete process.env.ORCHA_AUTOANCHOR_DISABLE_TRIGGER;
    process.env.ORCHA_AUTOANCHOR_THRESHOLD = '8';
    process.env.ORCHA_AUTOANCHOR_MIN_INTERVAL_SECONDS = '0';
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    resetAutoAnchorTriggerThrottle();
    delete process.env.ORCHA_AUTOANCHOR_THRESHOLD;
    delete process.env.ORCHA_AUTOANCHOR_MIN_INTERVAL_SECONDS;
  });

  describe('countUntaggedObservations', () => {
    it('counts only entries without anchorRefs', () => {
      writeSidecar(3, 5);
      expect(countUntaggedObservations(DATA_DIR)).toBe(5);
    });

    it('treats an empty anchorRefs array as untagged', () => {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(SIDECAR, JSON.stringify({ a: { anchorRefs: [] }, b: {} }), 'utf-8');
      expect(countUntaggedObservations(DATA_DIR)).toBe(2);
    });

    it('returns 0 when no sidecar exists', () => {
      expect(countUntaggedObservations(DATA_DIR)).toBe(0);
    });
  });

  describe('maybeTriggerAutoAnchor', () => {
    it('does not fire below the untagged threshold', () => {
      writeSidecar(0, 7); // 7 < 8
      const r = maybeTriggerAutoAnchor(SESSION_DIR, SESSION_ID);
      expect(r.triggered).toBe(false);
      expect(r.untaggedCount).toBe(7);
      expect(r.reason).toContain('below threshold');
    });

    it('fires at/above threshold (CRAFT_APP_ROOT unset → decision still true, spawn no-ops)', () => {
      writeSidecar(2, 8); // 8 >= 8
      const r = maybeTriggerAutoAnchor(SESSION_DIR, SESSION_ID);
      expect(r.triggered).toBe(true);
      expect(r.untaggedCount).toBe(8);
    });

    it('respects the disable flag', () => {
      process.env.ORCHA_AUTOANCHOR_DISABLE_TRIGGER = '1';
      writeSidecar(0, 20);
      expect(maybeTriggerAutoAnchor(SESSION_DIR, SESSION_ID).triggered).toBe(false);
    });

    it('throttles a second call within the min interval', () => {
      process.env.ORCHA_AUTOANCHOR_MIN_INTERVAL_SECONDS = '300';
      writeSidecar(0, 10);
      expect(maybeTriggerAutoAnchor(SESSION_DIR, SESSION_ID).triggered).toBe(true);
      const second = maybeTriggerAutoAnchor(SESSION_DIR, SESSION_ID);
      expect(second.triggered).toBe(false);
      expect(second.reason).toContain('throttled');
    });

    it('does not fire for a missing session dir', () => {
      const r = maybeTriggerAutoAnchor(join(TEST_DIR, 'nope'), 'ghost');
      expect(r.triggered).toBe(false);
      expect(r.reason).toContain('does not exist');
    });

    it('accepts an envOverride (used by the electron wake-trigger) without changing the decision', () => {
      writeSidecar(0, 8);
      const r = maybeTriggerAutoAnchor(SESSION_DIR, SESSION_ID, {
        envOverride: { CLAUDE_CODE_OAUTH_TOKEN: 'fresh-token' },
      });
      expect(r.triggered).toBe(true);
      expect(r.untaggedCount).toBe(8);
    });
  });
});
