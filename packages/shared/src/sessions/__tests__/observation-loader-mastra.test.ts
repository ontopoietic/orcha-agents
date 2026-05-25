import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadObservationSignalsFromMastraMarkdown } from '../observation-loader.ts';

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
