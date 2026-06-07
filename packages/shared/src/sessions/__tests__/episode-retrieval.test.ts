import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  getRelevantEpisodes,
  renderRelevantEpisodesBlock,
  renderRecallHintBlock,
} from '../episode-retrieval.ts';
import { writeEpisode } from '../episode.ts';

const TEST_DIR = join(import.meta.dir, '__test_retrieval__');
const WORKSPACE = TEST_DIR;
const SESSIONS = join(WORKSPACE, 'sessions');

function mkSession(sessionId: string): string {
  const dir = join(SESSIONS, sessionId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeEp(
  sessionId: string,
  args: {
    anchors: Array<{ type: string; id: string; title?: string }>;
    endedAt: string;
    summary?: string;
    outcome?: 'resolved' | 'handoff' | 'blocked' | 'abandoned' | 'unknown';
    closeReason?: 'session-done' | 'anchor-change' | 'idle-cutoff' | 'manual';
  },
): { sessionId: string; epId: string } {
  const dir = mkSession(sessionId);
  const ep = writeEpisode(dir, {
    sessionId,
    workspaceId: 'ws',
    closeReason: args.closeReason ?? 'session-done',
    phase: {
      startMessageId: 'msg-1',
      endMessageId: 'msg-99',
      startedAt: args.endedAt,
      endedAt: args.endedAt,
      anchors: args.anchors,
    },
    summary: args.summary ?? 'Test summary',
    decisions: [],
    openQuestions: [],
    artifactsTouched: [],
    outcome: args.outcome ?? 'resolved',
  });
  return { sessionId, epId: ep.id };
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(SESSIONS, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('getRelevantEpisodes', () => {
  it('returns [] when no anchors supplied (no signal to filter on)', () => {
    writeEp('s1', { anchors: [{ type: 'feature', id: 'f1' }], endedAt: '2026-05-09T10:00:00.000Z' });
    expect(getRelevantEpisodes({ workspaceRoot: WORKSPACE, anchors: [] })).toEqual([]);
  });

  it('returns [] when sessions/ dir missing', () => {
    rmSync(SESSIONS, { recursive: true, force: true });
    const out = getRelevantEpisodes({
      workspaceRoot: WORKSPACE,
      anchors: [{ type: 'feature', id: 'f1' }],
    });
    expect(out).toEqual([]);
  });

  it('finds episodes whose anchors intersect', () => {
    writeEp('s1', { anchors: [{ type: 'feature', id: 'f1' }], endedAt: '2026-05-09T10:00:00.000Z' });
    writeEp('s2', { anchors: [{ type: 'feature', id: 'f2' }], endedAt: '2026-05-09T11:00:00.000Z' });
    const out = getRelevantEpisodes({
      workspaceRoot: WORKSPACE,
      anchors: [{ type: 'feature', id: 'f1' }],
    });
    expect(out.length).toBe(1);
    expect(out[0]!.sessionId).toBe('s1');
  });

  it('matches when ANY anchor intersects (set union, not exact match)', () => {
    writeEp('s1', {
      anchors: [
        { type: 'feature', id: 'f1' },
        { type: 'befund', id: 'b1' },
      ],
      endedAt: '2026-05-09T10:00:00.000Z',
    });
    const out = getRelevantEpisodes({
      workspaceRoot: WORKSPACE,
      anchors: [{ type: 'befund', id: 'b1' }],
    });
    expect(out.length).toBe(1);
  });

  it('orders newest endedAt first', () => {
    writeEp('s1', { anchors: [{ type: 'feature', id: 'f1' }], endedAt: '2026-05-09T08:00:00.000Z' });
    writeEp('s2', { anchors: [{ type: 'feature', id: 'f1' }], endedAt: '2026-05-09T20:00:00.000Z' });
    writeEp('s3', { anchors: [{ type: 'feature', id: 'f1' }], endedAt: '2026-05-09T14:00:00.000Z' });
    const out = getRelevantEpisodes({
      workspaceRoot: WORKSPACE,
      anchors: [{ type: 'feature', id: 'f1' }],
    });
    const order = out.map((h) => h.sessionId);
    expect(order).toEqual(['s2', 's3', 's1']);
  });

  it('respects limit', () => {
    for (let i = 0; i < 8; i++) {
      writeEp(`s${i}`, {
        anchors: [{ type: 'feature', id: 'f1' }],
        endedAt: `2026-05-09T${String(i).padStart(2, '0')}:00:00.000Z`,
      });
    }
    const out = getRelevantEpisodes({
      workspaceRoot: WORKSPACE,
      anchors: [{ type: 'feature', id: 'f1' }],
      limit: 3,
    });
    expect(out.length).toBe(3);
  });

  it('excludeSessionId removes the named session from results', () => {
    writeEp('s1', { anchors: [{ type: 'feature', id: 'f1' }], endedAt: '2026-05-09T10:00:00.000Z' });
    writeEp('s2', { anchors: [{ type: 'feature', id: 'f1' }], endedAt: '2026-05-09T11:00:00.000Z' });
    const out = getRelevantEpisodes({
      workspaceRoot: WORKSPACE,
      anchors: [{ type: 'feature', id: 'f1' }],
      excludeSessionId: 's2',
    });
    expect(out.length).toBe(1);
    expect(out[0]!.sessionId).toBe('s1');
  });

  it('onlySessionId restricts to that session', () => {
    writeEp('s1', { anchors: [{ type: 'feature', id: 'f1' }], endedAt: '2026-05-09T10:00:00.000Z' });
    writeEp('s2', { anchors: [{ type: 'feature', id: 'f1' }], endedAt: '2026-05-09T11:00:00.000Z' });
    const out = getRelevantEpisodes({
      workspaceRoot: WORKSPACE,
      anchors: [{ type: 'feature', id: 'f1' }],
      onlySessionId: 's1',
    });
    expect(out.length).toBe(1);
    expect(out[0]!.sessionId).toBe('s1');
  });

  it('survives a corrupted index file gracefully', () => {
    const dir = mkSession('s_bad');
    mkdirSync(join(dir, 'episodes'), { recursive: true });
    const fs = require('node:fs') as typeof import('node:fs');
    fs.writeFileSync(join(dir, 'episodes', 'index.json'), '{garbage', 'utf-8');

    writeEp('s_good', { anchors: [{ type: 'feature', id: 'f1' }], endedAt: '2026-05-09T10:00:00.000Z' });
    const out = getRelevantEpisodes({
      workspaceRoot: WORKSPACE,
      anchors: [{ type: 'feature', id: 'f1' }],
    });
    expect(out.length).toBe(1);
    expect(out[0]!.sessionId).toBe('s_good');
  });
});

describe('renderRelevantEpisodesBlock', () => {
  it('returns null for empty hits', () => {
    expect(renderRelevantEpisodesBlock([])).toBeNull();
  });

  it('renders a block with envelope tag, summary, anchors, outcome', () => {
    const ep = writeEp('s1', {
      anchors: [{ type: 'feature', id: 'f1', title: 'My Feature' }],
      endedAt: '2026-05-09T15:00:00.000Z',
      summary: 'Did some important work',
      outcome: 'handoff',
    });
    const out = getRelevantEpisodes({
      workspaceRoot: WORKSPACE,
      anchors: [{ type: 'feature', id: 'f1' }],
    });
    const block = renderRelevantEpisodesBlock(out);
    expect(block).not.toBeNull();
    expect(block!).toContain('<relevant_episodes>');
    expect(block!).toContain('</relevant_episodes>');
    expect(block!).toContain(ep.epId);
    expect(block!).toContain('My Feature');
    expect(block!).toContain('outcome=handoff');
    expect(block!).toContain('Did some important work');
  });
});

describe('renderRecallHintBlock', () => {
  it('returns null for empty hits', () => {
    expect(renderRecallHintBlock([], [{ type: 'feature', id: 'f1' }])).toBeNull();
  });

  it('returns null when no hit anchor intersects the session anchors', () => {
    writeEp('s1', {
      anchors: [{ type: 'feature', id: 'f1', title: 'My Feature' }],
      endedAt: '2026-05-09T15:00:00.000Z',
    });
    const out = getRelevantEpisodes({
      workspaceRoot: WORKSPACE,
      anchors: [{ type: 'feature', id: 'f1' }],
    });
    // Hits exist, but we narrow against a disjoint session-anchor set.
    expect(renderRecallHintBlock(out, [{ type: 'feature', id: 'other' }])).toBeNull();
  });

  it('emits a slim pointer naming the shared anchor and the recall tool', () => {
    writeEp('s1', {
      anchors: [{ type: 'feature', id: 'f1', title: 'My Feature' }],
      endedAt: '2026-05-09T15:00:00.000Z',
      summary: 'Did some important work',
    });
    const out = getRelevantEpisodes({
      workspaceRoot: WORKSPACE,
      anchors: [{ type: 'feature', id: 'f1' }],
    });
    const block = renderRecallHintBlock(out, [{ type: 'feature', id: 'f1' }]);
    expect(block).not.toBeNull();
    expect(block!).toContain('<relevant_memory>');
    expect(block!).toContain('</relevant_memory>');
    expect(block!).toContain('My Feature');
    expect(block!).toContain('anchorType=feature');
    expect(block!).toContain('anchorId=f1');
    expect(block!).toContain('`recall`');
    // The slim pointer must NOT dump the full episode summary.
    expect(block!).not.toContain('Did some important work');
  });
});
