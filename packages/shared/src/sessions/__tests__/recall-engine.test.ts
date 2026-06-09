import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  recall,
  resolvePointer,
  gatherRecallHint,
  renderRecallHintBlock,
} from '../recall-engine.ts';

const ROOT = join(import.meta.dir, '__test_recall_ws__');
const FEATURE_A = '40296119-bd35-4fe7-8b7d-78b9cba234c4';
const FEATURE_B = 'ffffffff-0000-0000-0000-000000000000';

/** Write a session fixture: ledger + evidence sidecar + jsonl. */
function writeSession(
  sessionId: string,
  bullets: Array<{
    short: string;
    summary: string;
    excerpt: string;
    actor: 'user' | 'agent';
    createdAt: string;
    msgId: string;
    anchor?: { type: string; id: string; title: string };
  }>,
  jsonlMessages: Array<{ id: string; content: string; type: string }>,
) {
  const dataDir = join(ROOT, 'sessions', sessionId, 'data');
  mkdirSync(dataDir, { recursive: true });

  const md =
    '# 2026-05-22\n' +
    bullets.map((b) => `- 🔴 10:00 ${b.summary} {${b.short}}`).join('\n') +
    '\n';
  writeFileSync(join(dataDir, 'observations.md'), md, 'utf-8');

  const sidecar: Record<string, unknown> = {};
  for (const b of bullets) {
    sidecar[b.short] = {
      fullMessageId: b.msgId,
      messageRangeTo: b.msgId,
      excerpt: b.excerpt,
      actor: b.actor,
      createdAt: b.createdAt,
      ...(b.anchor
        ? { anchorRefs: [{ ...b.anchor, addedAt: '2026-05-07T00:00:00.000Z', addedBy: 'user' }] }
        : {}),
    };
  }
  writeFileSync(join(dataDir, 'observations-evidence.json'), JSON.stringify(sidecar), 'utf-8');

  // jsonl: header line + messages
  const header = { id: sessionId, workspaceRootPath: ROOT };
  const lines = [JSON.stringify(header), ...jsonlMessages.map((m) => JSON.stringify({ ...m, timestamp: 1 }))];
  writeFileSync(join(ROOT, 'sessions', sessionId, 'session.jsonl'), lines.join('\n') + '\n', 'utf-8');
}

describe('recall-engine', () => {
  beforeEach(() => {
    if (existsSync(ROOT)) rmSync(ROOT, { recursive: true });
    mkdirSync(ROOT, { recursive: true });

    writeSession(
      '260507-apt-flood',
      [
        {
          short: 'aaa111',
          summary: 'User chose the Userflow Graph 2D layout engine',
          excerpt: 'Lass uns den Userflow Graph in 2D rendern statt 3D.',
          actor: 'user',
          createdAt: '2026-05-08T17:56:29.002Z',
          msgId: 'msg-1778254265335-aaa111',
          anchor: { type: 'feature', id: FEATURE_A, title: 'Userflow Graph 2D' },
        },
      ],
      [
        { id: 'msg-1778254265000-zzz000', content: 'context before', type: 'assistant' },
        { id: 'msg-1778254265335-aaa111', content: 'Lass uns den Userflow Graph in 2D rendern statt 3D.', type: 'user' },
        { id: 'msg-1778254265999-yyy999', content: 'context after', type: 'assistant' },
      ],
    );

    writeSession(
      '260601-other-topic',
      [
        {
          short: 'bbb222',
          summary: 'Reflector threshold changed to count-based trigger',
          excerpt: 'Der Reflector feuert jetzt nach 60 Observations.',
          actor: 'agent',
          createdAt: '2026-06-01T12:00:00.000Z',
          msgId: 'msg-1779000000000-bbb222',
          anchor: { type: 'feature', id: FEATURE_B, title: 'Observer Tuning' },
        },
      ],
      [{ id: 'msg-1779000000000-bbb222', content: 'Der Reflector feuert jetzt nach 60 Observations.', type: 'agent' }],
    );
  });

  afterEach(() => {
    if (existsSync(ROOT)) rmSync(ROOT, { recursive: true });
  });

  it('finds an observation across sessions by anchor (exact filter)', () => {
    const hits = recall(ROOT, { anchor: { type: 'feature', id: FEATURE_A } });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.sessionId).toBe('260507-apt-flood');
    expect(hits[0]!.matched).toContain('anchor');
    expect(hits[0]!.score).toBeGreaterThanOrEqual(1.0);
    // Durable pointer survived end-to-end.
    expect(hits[0]!.messageRange.from).toBe('msg-1778254265335-aaa111');
  });

  it('scores text overlap and ranks the better match first', () => {
    const hits = recall(ROOT, { text: 'reflector threshold trigger' });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.sessionId).toBe('260601-other-topic');
    expect(hits[0]!.matched).toContain('text');
  });

  it('anchor filter excludes non-matching observations', () => {
    const hits = recall(ROOT, { anchor: { type: 'feature', id: FEATURE_B } });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.sessionId).toBe('260601-other-topic');
  });

  it('empty query returns most-recent observations (recency)', () => {
    const hits = recall(ROOT, {});
    expect(hits.length).toBe(2);
    // 260601 is newer than 260507 → comes first.
    expect(hits[0]!.sessionId).toBe('260601-other-topic');
    expect(hits[0]!.matched).toContain('recency');
  });

  it('resolves a pointer to the raw message window', () => {
    const resolved = resolvePointer(ROOT, '260507-apt-flood', 'msg-1778254265335-aaa111', { before: 1, after: 1 });
    expect(resolved).not.toBeNull();
    expect(resolved!.messages).toHaveLength(3);
    expect(resolved!.messages[resolved!.anchorIndex]!.id).toBe('msg-1778254265335-aaa111');
    expect(resolved!.messages[resolved!.anchorIndex]!.content).toContain('Userflow Graph in 2D');
  });

  it('resolvePointer returns null for an unknown message', () => {
    expect(resolvePointer(ROOT, '260507-apt-flood', 'msg-does-not-exist')).toBeNull();
  });

  describe('gatherRecallHint / renderRecallHintBlock', () => {
    it('detects cross-session matches and renders a slim pointer', () => {
      // A NEW session anchored to FEATURE_A; the match lives in 260507-apt-flood.
      const data = gatherRecallHint({
        workspaceRootPath: ROOT,
        sessionId: '260607-new-session',
        anchors: [{ type: 'feature', id: FEATURE_A }],
      });
      expect(data.observationCount).toBe(1);
      expect(data.sessionCount).toBe(1);
      expect(data.sessionIds).toEqual(['260507-apt-flood']);
      expect(data.anchors).toHaveLength(1);
      // Title is snapshotted from the matched observation's anchorRef.
      expect(data.anchors[0]!.title).toBe('Userflow Graph 2D');

      const block = renderRecallHintBlock(data);
      expect(block).not.toBeNull();
      expect(block!).toContain('<relevant_memory>');
      expect(block!).toContain(`anchorId="${FEATURE_A}"`);
      expect(block!).toContain('`recall`');
      // Names the source session so the agent knows where the prior work lives.
      expect(block!).toContain('260507-apt-flood');
      // Directive: a concrete recall invocation the agent can copy.
      expect(block!).toContain(`recall({ anchorType: "feature", anchorId: "${FEATURE_A}"`);
      // Slim pointer must NOT dump the observation summary.
      expect(block!).not.toContain('Userflow Graph 2D layout engine');
    });

    it('excludes the current session (cross-session only)', () => {
      // The current session IS the one holding the FEATURE_A observation.
      const data = gatherRecallHint({
        workspaceRootPath: ROOT,
        sessionId: '260507-apt-flood',
        anchors: [{ type: 'feature', id: FEATURE_A }],
      });
      expect(data.observationCount).toBe(0);
      expect(renderRecallHintBlock(data)).toBeNull();
    });

    it('returns null block when no other session shares the anchor', () => {
      const data = gatherRecallHint({
        workspaceRootPath: ROOT,
        sessionId: '260607-new-session',
        anchors: [{ type: 'feature', id: 'unknown-anchor-id' }],
      });
      expect(data.observationCount).toBe(0);
      expect(renderRecallHintBlock(data)).toBeNull();
    });

    it('ignores non-framework anchor types', () => {
      const data = gatherRecallHint({
        workspaceRootPath: ROOT,
        sessionId: '260607-new-session',
        // 'not-a-real-type' is not a framework AnchorType → must be skipped.
        anchors: [{ type: 'not-a-real-type', id: FEATURE_A }],
      });
      expect(data.observationCount).toBe(0);
    });
  });
});
