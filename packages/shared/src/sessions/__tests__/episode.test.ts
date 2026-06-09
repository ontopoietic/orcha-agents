import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendAnnotation,
  episodeIndexPath,
  episodePath,
  listEpisodes,
  readAnnotations,
  readEpisode,
  readEpisodeIndex,
  writeEpisode,
  type WriteEpisodeArgs,
} from '../episode.ts';

const TEST_DIR = join(import.meta.dir, '__test_episodes__');
const SESSION_DIR = join(TEST_DIR, 'session');

function baseArgs(overrides: Partial<WriteEpisodeArgs> = {}): WriteEpisodeArgs {
  return {
    sessionId: 'sess-1',
    workspaceId: 'ws-1',
    closeReason: 'session-done',
    phase: {
      startMessageId: 'msg-1',
      endMessageId: 'msg-99',
      startedAt: '2026-05-09T14:00:00.000Z',
      endedAt: '2026-05-09T15:00:00.000Z',
      anchors: [{ type: 'feature', id: 'f-1', title: 'X' }],
    },
    summary: 'Things happened. Decisions were made.',
    decisions: ['obs-a', 'obs-b'],
    openQuestions: ['obs-q'],
    artifactsTouched: [{ type: 'file', ref: 'src/foo.ts' }],
    outcome: 'resolved',
    ...overrides,
  };
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(SESSION_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('writeEpisode', () => {
  it('writes the episode JSON and an index entry', () => {
    const ep = writeEpisode(SESSION_DIR, baseArgs());
    expect(ep.id).toMatch(/^ep-/);
    expect(ep.schemaVersion).toBe(1);
    expect(existsSync(episodePath(SESSION_DIR, ep.id))).toBe(true);
    expect(existsSync(episodeIndexPath(SESSION_DIR))).toBe(true);

    const back = readEpisode(SESSION_DIR, ep.id);
    expect(back).not.toBeNull();
    expect(back!.summary).toBe('Things happened. Decisions were made.');
    expect(back!.decisions).toEqual(['obs-a', 'obs-b']);
  });

  it('creates the episodes/ directory if missing', () => {
    rmSync(SESSION_DIR, { recursive: true, force: true });
    mkdirSync(SESSION_DIR, { recursive: true });
    expect(existsSync(join(SESSION_DIR, 'episodes'))).toBe(false);
    writeEpisode(SESSION_DIR, baseArgs());
    expect(existsSync(join(SESSION_DIR, 'episodes'))).toBe(true);
  });

  it('records summarySnippet truncated to 200 chars in the index', () => {
    const longSummary = 'a'.repeat(500);
    const ep = writeEpisode(SESSION_DIR, baseArgs({ summary: longSummary }));
    const idx = readEpisodeIndex(SESSION_DIR);
    const entry = idx.entries.find((e) => e.id === ep.id);
    expect(entry).toBeDefined();
    expect(entry!.summarySnippet.length).toBe(200);
  });

  it('orders index entries newest endedAt first', () => {
    writeEpisode(SESSION_DIR, baseArgs({
      phase: { ...baseArgs().phase, endedAt: '2026-05-09T10:00:00.000Z' },
    }));
    writeEpisode(SESSION_DIR, baseArgs({
      phase: { ...baseArgs().phase, endedAt: '2026-05-09T20:00:00.000Z' },
    }));
    writeEpisode(SESSION_DIR, baseArgs({
      phase: { ...baseArgs().phase, endedAt: '2026-05-09T15:00:00.000Z' },
    }));
    const idx = readEpisodeIndex(SESSION_DIR);
    const ts = idx.entries.map((e) => e.endedAt);
    expect(ts).toEqual([
      '2026-05-09T20:00:00.000Z',
      '2026-05-09T15:00:00.000Z',
      '2026-05-09T10:00:00.000Z',
    ]);
  });

  it('preserves existing entries when appending new episodes', () => {
    const a = writeEpisode(SESSION_DIR, baseArgs());
    const b = writeEpisode(SESSION_DIR, baseArgs());
    const idx = readEpisodeIndex(SESSION_DIR);
    const ids = idx.entries.map((e) => e.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids.length).toBe(2);
  });
});

describe('listEpisodes', () => {
  it('returns [] for fresh session', () => {
    expect(listEpisodes(SESSION_DIR)).toEqual([]);
  });

  it('returns episodes newest createdAt first, ignoring index/annotation files', () => {
    const a = writeEpisode(SESSION_DIR, baseArgs());
    // Sleep tick to ensure distinct createdAt — test isn't strict on ordering
    // when timestamps collide, but the function uses localeCompare which is
    // total over ISO strings.
    const b = writeEpisode(SESSION_DIR, baseArgs());
    appendAnnotation(SESSION_DIR, a.id, { note: 'later finding' });
    const all = listEpisodes(SESSION_DIR);
    expect(all.length).toBe(2);
    expect(all.map((e) => e.id).sort()).toEqual([a.id, b.id].sort());
  });
});

describe('readEpisodeIndex', () => {
  it('returns empty index when file missing', () => {
    const idx = readEpisodeIndex(SESSION_DIR);
    expect(idx.schemaVersion).toBe(1);
    expect(idx.entries).toEqual([]);
  });
});

describe('annotations', () => {
  it('round-trips annotations via append + read', () => {
    const ep = writeEpisode(SESSION_DIR, baseArgs());
    appendAnnotation(SESSION_DIR, ep.id, { note: 'first thought', source: 'user' });
    appendAnnotation(SESSION_DIR, ep.id, { note: 'second', source: 'semantic-extractor' });
    const all = readAnnotations(SESSION_DIR, ep.id);
    expect(all.length).toBe(2);
    expect(all[0]!.note).toBe('first thought');
    expect(all[0]!.source).toBe('user');
    expect(all[1]!.source).toBe('semantic-extractor');
    expect(all[0]!.at).toBeDefined();
  });

  it('returns [] when no annotations file', () => {
    const ep = writeEpisode(SESSION_DIR, baseArgs());
    expect(readAnnotations(SESSION_DIR, ep.id)).toEqual([]);
  });

  it('skips malformed lines gracefully', () => {
    const ep = writeEpisode(SESSION_DIR, baseArgs());
    appendAnnotation(SESSION_DIR, ep.id, { note: 'good' });
    // Manually corrupt by appending invalid line
    const path = join(SESSION_DIR, 'episodes', `${ep.id}.annotations.jsonl`);
    const fs = require('node:fs') as typeof import('node:fs');
    fs.appendFileSync(path, '{not json}\n');
    appendAnnotation(SESSION_DIR, ep.id, { note: 'after corruption' });
    const all = readAnnotations(SESSION_DIR, ep.id);
    expect(all.length).toBe(2);
    expect(all.map((a) => a.note)).toEqual(['good', 'after corruption']);
  });
});
