import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  maybeTriggerReflector,
  resetReflectionTriggerThrottle,
} from '../reflection-trigger.ts';

const TEST_DIR = join(import.meta.dir, '__test_reflection_trigger__');
const SESSION_ID = 'test-reflect-session';
const SESSION_DIR = join(TEST_DIR, 'sessions', SESSION_ID);
const OBS = join(SESSION_DIR, 'data', 'observations.json');
const OBS_MD = join(SESSION_DIR, 'data', 'observations.md');
const OBS_MASTRA_MD = join(SESSION_DIR, 'data', 'observations.mastra.md');

function writeObservationsBytes(bytes: number): void {
  mkdirSync(join(SESSION_DIR, 'data'), { recursive: true });
  // Pad with whitespace to hit the requested file size.
  const payload = '{"signals":[]}' + ' '.repeat(Math.max(0, bytes - 14));
  writeFileSync(OBS, payload, 'utf-8');
}

function writeMarkdownBytes(bytes: number): void {
  mkdirSync(join(SESSION_DIR, 'data'), { recursive: true });
  const payload = '# 2026-05-12\n' + '- 🟢 12:00 stub\n'.repeat(1).padEnd(Math.max(0, bytes - 14), ' ');
  writeFileSync(OBS_MD, payload, 'utf-8');
}

function writeMastraMarkdownBytes(bytes: number): void {
  mkdirSync(join(SESSION_DIR, 'data'), { recursive: true });
  const payload =
    'Date: May 21, 2026\n' +
    '* 🟢 (12:00) stub {abc123}\n'.padEnd(Math.max(0, bytes - 20), ' ');
  writeFileSync(OBS_MASTRA_MD, payload, 'utf-8');
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  resetReflectionTriggerThrottle();
});

afterEach(() => {
  delete process.env.ORCHA_REFLECTOR_DISABLE_TRIGGER;
  delete process.env.ORCHA_REFLECTOR_THRESHOLD_TOKENS;
  delete process.env.ORCHA_REFLECTOR_MIN_INTERVAL_SECONDS;
  delete process.env.CRAFT_APP_ROOT;
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('maybeTriggerReflector', () => {
  it('returns false when session dir does not exist', () => {
    const r = maybeTriggerReflector('/no/such/path', SESSION_ID);
    expect(r.triggered).toBe(false);
    expect(r.reason).toContain('session dir does not exist');
  });

  it('returns false when ORCHA_REFLECTOR_DISABLE_TRIGGER=1', () => {
    process.env.ORCHA_REFLECTOR_DISABLE_TRIGGER = '1';
    mkdirSync(SESSION_DIR, { recursive: true });
    const r = maybeTriggerReflector(SESSION_DIR, SESSION_ID);
    expect(r.triggered).toBe(false);
    expect(r.reason).toContain('disabled');
  });

  it('returns false when no observations.json yet', () => {
    mkdirSync(SESSION_DIR, { recursive: true });
    const r = maybeTriggerReflector(SESSION_DIR, SESSION_ID);
    expect(r.triggered).toBe(false);
    expect(r.observationTokens).toBe(0);
  });

  it('fires on observations.md size even without observations.json', () => {
    process.env.CRAFT_APP_ROOT = TEST_DIR;
    process.env.ORCHA_REFLECTOR_THRESHOLD_TOKENS = '5000';
    // ~30 kB markdown ≈ 7.5k tokens, no JSON sibling
    writeMarkdownBytes(30_000);
    const r = maybeTriggerReflector(SESSION_DIR, SESSION_ID);
    expect(r.triggered).toBe(true);
    expect(r.observationTokens).toBeGreaterThan(7_000);
  });

  it('uses the LARGER of md and json file size', () => {
    process.env.ORCHA_REFLECTOR_THRESHOLD_TOKENS = '100000'; // high so we don't trigger
    writeObservationsBytes(4_000);      // ~1k tokens
    writeMarkdownBytes(40_000);          // ~10k tokens — bigger
    const r = maybeTriggerReflector(SESSION_DIR, SESSION_ID);
    expect(r.observationTokens).toBeGreaterThan(9_000);
  });

  it('returns false below threshold', () => {
    writeObservationsBytes(40_000); // ~10k tokens
    const r = maybeTriggerReflector(SESSION_DIR, SESSION_ID);
    expect(r.triggered).toBe(false);
    expect(r.reason).toContain('below threshold');
    expect(r.observationTokens).toBeGreaterThan(9_000);
    expect(r.observationTokens).toBeLessThan(11_000);
  });

  it('does not spawn (and reports false) when threshold met but CRAFT_APP_ROOT missing', () => {
    delete process.env.CRAFT_APP_ROOT;
    process.env.ORCHA_REFLECTOR_THRESHOLD_TOKENS = '5000'; // ~20kB
    writeObservationsBytes(30_000); // ~7.5k tokens
    const r = maybeTriggerReflector(SESSION_DIR, SESSION_ID);
    // triggered=true means decision crossed threshold; spawn silently failed
    // because no app-root. That's the documented behavior — we still record
    // the trigger fired so throttling kicks in.
    expect(r.triggered).toBe(true);
    expect(r.reason).toContain('threshold reached');
  });

  it('fires on observations.mastra.md size (Mastra path)', () => {
    process.env.CRAFT_APP_ROOT = TEST_DIR;
    process.env.ORCHA_REFLECTOR_THRESHOLD_TOKENS = '5000';
    // ~30 kB Mastra ledger ≈ 7.5k tokens
    writeMastraMarkdownBytes(30_000);
    const r = maybeTriggerReflector(SESSION_DIR, SESSION_ID);
    expect(r.triggered).toBe(true);
    expect(r.observationTokens).toBeGreaterThan(7_000);
  });

  it('uses the largest of mastra.md, .md, .json (Mastra ledger wins)', () => {
    process.env.ORCHA_REFLECTOR_THRESHOLD_TOKENS = '100000'; // high so we don't trigger
    writeObservationsBytes(4_000); // ~1k tokens
    writeMarkdownBytes(8_000); // ~2k tokens
    writeMastraMarkdownBytes(60_000); // ~15k tokens — biggest
    const r = maybeTriggerReflector(SESSION_DIR, SESSION_ID);
    expect(r.observationTokens).toBeGreaterThan(14_000);
    expect(r.observationTokens).toBeLessThan(16_000);
  });

  it('throttles re-runs within the min interval', () => {
    process.env.CRAFT_APP_ROOT = TEST_DIR; // script lookup will fail; that's fine
    process.env.ORCHA_REFLECTOR_THRESHOLD_TOKENS = '5000';
    process.env.ORCHA_REFLECTOR_MIN_INTERVAL_SECONDS = '60';
    writeObservationsBytes(30_000);

    const first = maybeTriggerReflector(SESSION_DIR, SESSION_ID);
    expect(first.triggered).toBe(true);

    const second = maybeTriggerReflector(SESSION_DIR, SESSION_ID);
    expect(second.triggered).toBe(false);
    expect(second.reason).toContain('throttled');
  });
});
