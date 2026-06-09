import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadObservationSignalsFromMastraMarkdown,
  loadObservationSignals,
  mergeObservationSignals,
} from '../observation-loader.ts';
import type { ObservationSignal } from '../observation-watermark.ts';

const TEST_DIR = join(import.meta.dir, '__test_loader_mastra__');

describe('loadObservationSignalsFromMastraMarkdown', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(join(TEST_DIR, 'data'), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('returns null when the Mastra ledger file is missing', () => {
    expect(loadObservationSignalsFromMastraMarkdown(TEST_DIR)).toBeNull();
  });

  it('populates messageRange + excerpt + actor from the Mastra evidence sidecar', () => {
    writeFileSync(
      join(TEST_DIR, 'data', 'observations.mastra.md'),
      `Date: May 21, 2026
* 🔴 (14:30) User chose feature-branch workflow {abc123}
* 🟡 (14:31) Open question on DB choice {def456}`,
      'utf-8',
    );
    writeFileSync(
      join(TEST_DIR, 'data', 'observations-evidence.mastra.json'),
      JSON.stringify({
        abc123: {
          fullMessageId: 'msg-1779114000000-abc123',
          excerpt: 'I want feature-branch only',
          actor: 'user',
          createdAt: '2026-05-21T14:30:00.000Z',
        },
        def456: {
          fullMessageId: 'msg-1779114060000-def456',
          excerpt: 'should we use Cloudflare D1?',
          actor: 'user',
          createdAt: '2026-05-21T14:31:00.000Z',
        },
      }),
      'utf-8',
    );

    const signals = loadObservationSignalsFromMastraMarkdown(TEST_DIR);
    expect(signals).not.toBeNull();
    expect(signals).toHaveLength(2);

    const first = signals![0]!;
    expect(first.id).toBe('obs-abc123');
    expect(first.salience).toBe('pivotal');
    expect(first.summary).toBe('User chose feature-branch workflow');
    expect(first.conversation!.messageRange!.from).toBe('msg-1779114000000-abc123');
    expect(first.conversation?.excerpt).toBe('I want feature-branch only');
    expect(first.conversation?.actor).toBe('user');
    expect(first.createdAt).toBe('2026-05-21T14:30:00.000Z');
  });

  it('falls back to empty messageRange when sidecar entry is missing for an anchor', () => {
    writeFileSync(
      join(TEST_DIR, 'data', 'observations.mastra.md'),
      `Date: May 21, 2026
* 🔴 (14:30) Bullet with anchor but no sidecar entry {orphan}`,
      'utf-8',
    );
    // No sidecar file at all.
    const signals = loadObservationSignalsFromMastraMarkdown(TEST_DIR);
    expect(signals).toHaveLength(1);
    expect(signals![0]!.id).toBe('obs-orphan');
    expect(signals![0]!.conversation!.messageRange!.from).toBe('');
    expect(signals![0]!.conversation!.excerpt).toBe('');
  });

  it('returns bullet-index IDs when idStrategy is bullet-index', () => {
    writeFileSync(
      join(TEST_DIR, 'data', 'observations.mastra.md'),
      `Date: May 21, 2026
* 🔴 (14:30) First {a11111}
* 🟢 (14:31) Second {b22222}`,
      'utf-8',
    );
    const signals = loadObservationSignalsFromMastraMarkdown(TEST_DIR, 'bullet-index');
    expect(signals!.map((s) => s.id)).toEqual(['bullet-0', 'bullet-1']);
  });

  it('uses generic obs-mastra-<i> ID when a bullet has no anchor', () => {
    writeFileSync(
      join(TEST_DIR, 'data', 'observations.mastra.md'),
      `Date: May 21, 2026
* 🔴 (14:30) Bullet without anchor`,
      'utf-8',
    );
    const signals = loadObservationSignalsFromMastraMarkdown(TEST_DIR);
    expect(signals![0]!.id).toBe('obs-mastra-0');
  });
});

describe('mergeObservationSignals', () => {
  const mk = (id: string, createdAt: string): ObservationSignal => ({
    id,
    createdAt,
    source: 'conversation',
    summary: id,
    status: 'raw',
    salience: 'context',
  });

  it('preferred wins on ID collision; both contribute the rest', () => {
    const preferred = [mk('obs-a', '2026-05-21T10:00:00Z'), mk('obs-b', '2026-05-21T11:00:00Z')];
    const fallback = [mk('obs-a', '2026-05-21T09:00:00Z'), mk('obs-c', '2026-05-21T12:00:00Z')];
    const merged = mergeObservationSignals(preferred, fallback);
    expect(merged.map((s) => s.id)).toEqual(['obs-a', 'obs-b', 'obs-c']);
    // Preferred version of obs-a was kept (10:00, not 09:00)
    expect(merged.find((s) => s.id === 'obs-a')!.createdAt).toBe('2026-05-21T10:00:00Z');
  });

  it('sorts merged result ascending by createdAt', () => {
    const preferred = [mk('obs-late', '2026-05-21T15:00:00Z')];
    const fallback = [mk('obs-early', '2026-05-21T09:00:00Z'), mk('obs-mid', '2026-05-21T12:00:00Z')];
    const merged = mergeObservationSignals(preferred, fallback);
    expect(merged.map((s) => s.id)).toEqual(['obs-early', 'obs-mid', 'obs-late']);
  });

  it('returns empty when both inputs empty', () => {
    expect(mergeObservationSignals([], [])).toEqual([]);
  });
});

describe('loadObservationSignals (combined)', () => {
  const TEST_DIR_COMBINED = join(import.meta.dir, '__test_loader_combined__');

  beforeEach(() => {
    if (existsSync(TEST_DIR_COMBINED)) rmSync(TEST_DIR_COMBINED, { recursive: true });
    mkdirSync(join(TEST_DIR_COMBINED, 'data'), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR_COMBINED)) rmSync(TEST_DIR_COMBINED, { recursive: true });
  });

  it('merges Mastra ledger and legacy observations.md when both exist', () => {
    // Mastra ledger with anchor abc123
    writeFileSync(
      join(TEST_DIR_COMBINED, 'data', 'observations.mastra.md'),
      `Date: May 22, 2026
* 🔴 (10:00) Mastra-era bullet {abc123}`,
      'utf-8',
    );
    writeFileSync(
      join(TEST_DIR_COMBINED, 'data', 'observations-evidence.mastra.json'),
      JSON.stringify({
        abc123: {
          fullMessageId: 'msg-x-abc123',
          excerpt: 'mastra excerpt',
          actor: 'user',
          createdAt: '2026-05-22T10:00:00.000Z',
        },
      }),
      'utf-8',
    );
    // Legacy ledger with anchor def456 (different anchor, earlier date)
    writeFileSync(
      join(TEST_DIR_COMBINED, 'data', 'observations.md'),
      `# 2026-05-18
- 🟢 09:00 Legacy-era bullet {def456}`,
      'utf-8',
    );
    writeFileSync(
      join(TEST_DIR_COMBINED, 'data', 'observations-evidence.json'),
      JSON.stringify({
        def456: {
          fullMessageId: 'msg-y-def456',
          excerpt: 'legacy excerpt',
          actor: 'agent',
          createdAt: '2026-05-18T09:00:00.000Z',
        },
      }),
      'utf-8',
    );

    const signals = loadObservationSignals(TEST_DIR_COMBINED);
    expect(signals).toHaveLength(2);
    // Sorted ascending by createdAt: legacy (May 18) before Mastra (May 22)
    expect(signals[0]!.id).toBe('obs-def456');
    expect(signals[1]!.id).toBe('obs-abc123');
  });

  it('derives conversation.sessionId from the session directory name (B2 pointer)', () => {
    // Both ledgers, single bullet each — assert the cross-session pointer
    // carries the sessionId (folder basename), not the old hardcoded ''.
    writeFileSync(
      join(TEST_DIR_COMBINED, 'data', 'observations.mastra.md'),
      `Date: May 22, 2026
* 🔴 (10:00) Mastra-era bullet {abc123}`,
      'utf-8',
    );
    writeFileSync(
      join(TEST_DIR_COMBINED, 'data', 'observations-evidence.mastra.json'),
      JSON.stringify({
        abc123: { fullMessageId: 'msg-x-abc123', createdAt: '2026-05-22T10:00:00.000Z' },
      }),
      'utf-8',
    );
    writeFileSync(
      join(TEST_DIR_COMBINED, 'data', 'observations.md'),
      `# 2026-05-18
- 🟢 09:00 Legacy-era bullet {def456}`,
      'utf-8',
    );
    writeFileSync(
      join(TEST_DIR_COMBINED, 'data', 'observations-evidence.json'),
      JSON.stringify({
        def456: { fullMessageId: 'msg-y-def456', createdAt: '2026-05-18T09:00:00.000Z' },
      }),
      'utf-8',
    );

    const expectedSessionId = '__test_loader_combined__';
    const signals = loadObservationSignals(TEST_DIR_COMBINED);
    expect(signals).toHaveLength(2);
    for (const s of signals) {
      expect(s.conversation?.sessionId).toBe(expectedSessionId);
      // Pointer still resolves the message range from the sidecar.
      expect(s.conversation?.messageRange?.from).toMatch(/^msg-/);
    }
  });
});
