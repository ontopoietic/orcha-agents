import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Embedder } from '../embedder.ts';
import { cosineSimilarity } from '../embedder.ts';
import {
  ensureEmbeddings,
  getVectorSidecarPath,
  loadVectorSidecar,
  embeddingTextFor,
} from '../vector-sidecar.ts';
import { recallSemantic } from '../recall-engine.ts';
import type { ObservationSignal } from '../observation-watermark.ts';

const WS = join(import.meta.dir, '__test_vector_sidecar_ws__');
const SESSION_ID = 'sess-1';
const SESSION_DIR = join(WS, 'sessions', SESSION_ID);

/**
 * Deterministic keyword embedder (dim 3, normalised axes): texts about cats,
 * dogs, and everything else land on orthogonal vectors, so similarity is
 * exactly 1 for a topic match and 0 otherwise. `calls` counts embed batches
 * to assert cache behaviour.
 */
function mockEmbedder(model = 'mock-v1'): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    model,
    dim: 3,
    calls,
    async embed(texts) {
      calls.push([...texts]);
      return texts.map((t) => {
        const s = t.toLowerCase();
        if (s.includes('katze') || s.includes('cat')) return Float32Array.from([1, 0, 0]);
        if (s.includes('hund') || s.includes('dog')) return Float32Array.from([0, 1, 0]);
        return Float32Array.from([0, 0, 1]);
      });
    },
  };
}

function signal(id: string, summary: string, createdAt: string): ObservationSignal {
  return {
    id,
    createdAt,
    source: 'conversation',
    summary,
    status: 'raw',
    conversation: {
      sessionId: SESSION_ID,
      messageRange: { from: `msg-${id}`, to: `msg-${id}` },
      excerpt: '',
      actor: 'agent',
    },
  } as ObservationSignal;
}

function writeSignals(signals: ObservationSignal[]): void {
  mkdirSync(join(SESSION_DIR, 'data'), { recursive: true });
  writeFileSync(join(SESSION_DIR, 'data', 'observations.json'), JSON.stringify(signals), 'utf-8');
}

beforeEach(() => {
  if (existsSync(WS)) rmSync(WS, { recursive: true });
  mkdirSync(join(SESSION_DIR, 'data'), { recursive: true });
});

afterEach(() => {
  if (existsSync(WS)) rmSync(WS, { recursive: true });
});

describe('ensureEmbeddings', () => {
  it('embeds missing signals, persists the sidecar, and reuses it on re-run', async () => {
    const embedder = mockEmbedder();
    const signals = [
      signal('obs-a', 'Die Katze schläft', '2026-06-01T10:00:00Z'),
      signal('obs-b', 'Der Hund bellt', '2026-06-01T11:00:00Z'),
    ];

    const first = await ensureEmbeddings(SESSION_DIR, signals, embedder);
    expect(first.size).toBe(2);
    expect(embedder.calls.length).toBe(1);
    expect(existsSync(getVectorSidecarPath(SESSION_DIR))).toBe(true);

    const second = await ensureEmbeddings(SESSION_DIR, signals, embedder);
    expect(second.size).toBe(2);
    expect(embedder.calls.length).toBe(1); // nothing re-embedded
    expect(cosineSimilarity(second.get('obs-a')!, Float32Array.from([1, 0, 0]))).toBeCloseTo(1);
  });

  it('re-embeds only entries whose text changed', async () => {
    const embedder = mockEmbedder();
    const v1 = [signal('obs-a', 'Die Katze schläft', '2026-06-01T10:00:00Z')];
    await ensureEmbeddings(SESSION_DIR, v1, embedder);

    const v2 = [signal('obs-a', 'Der Hund bellt jetzt', '2026-06-01T10:00:00Z')];
    const result = await ensureEmbeddings(SESSION_DIR, v2, embedder);
    expect(embedder.calls.length).toBe(2);
    expect(embedder.calls[1]).toEqual([embeddingTextFor(v2[0]!)]);
    expect(cosineSimilarity(result.get('obs-a')!, Float32Array.from([0, 1, 0]))).toBeCloseTo(1);
  });

  it('discards the whole cache when the model changes', async () => {
    const signals = [signal('obs-a', 'Die Katze schläft', '2026-06-01T10:00:00Z')];
    await ensureEmbeddings(SESSION_DIR, signals, mockEmbedder('model-a'));

    const next = mockEmbedder('model-b');
    await ensureEmbeddings(SESSION_DIR, signals, next);
    expect(next.calls.length).toBe(1); // cache from model-a not reused

    const sidecar = loadVectorSidecar(SESSION_DIR);
    expect(sidecar?.model).toBe('model-b');
  });

  it('survives a corrupt sidecar file', async () => {
    writeFileSync(getVectorSidecarPath(SESSION_DIR), '{not json', 'utf-8');
    const embedder = mockEmbedder();
    const result = await ensureEmbeddings(
      SESSION_DIR,
      [signal('obs-a', 'Die Katze schläft', '2026-06-01T10:00:00Z')],
      embedder,
    );
    expect(result.size).toBe(1);
    expect(loadVectorSidecar(SESSION_DIR)?.model).toBe('mock-v1');
  });
});

describe('recallSemantic', () => {
  const clock = () => Date.parse('2026-06-02T00:00:00Z');

  it('ranks by embedding similarity and tags hits as semantic', async () => {
    writeSignals([
      // Different wording than the query — token overlap is zero, only the
      // embedding axis can find it.
      signal('obs-cat', 'Feline asleep on the sofa cat', '2026-06-01T10:00:00Z'),
      signal('obs-dog', 'Der Hund bellt laut', '2026-06-01T11:00:00Z'),
    ]);

    const hits = await recallSemantic(WS, { text: 'Katze' }, { embedder: mockEmbedder() }, clock);
    expect(hits.length).toBe(1); // dog scores 0 similarity + 0 overlap → dropped
    expect(hits[0]!.summary).toContain('Feline');
    expect(hits[0]!.matched).toContain('semantic');
    expect(hits[0]!.messageRange.from).toBe('msg-obs-cat');
  });

  it('falls back to text-overlap recall when no embedder is available', async () => {
    writeSignals([signal('obs-a', 'Die Katze schläft', '2026-06-01T10:00:00Z')]);

    const hits = await recallSemantic(WS, { text: 'Katze' }, { embedder: null }, clock);
    expect(hits.length).toBe(1);
    expect(hits[0]!.matched).toContain('text');
    expect(hits[0]!.matched).not.toContain('semantic');
  });

  it('keeps anchors as a hard filter on top of semantic scoring', async () => {
    const tagged = signal('obs-cat', 'Feline asleep cat', '2026-06-01T10:00:00Z');
    (tagged as { anchorRefs?: unknown[] }).anchorRefs = [
      { type: 'feature', id: 'f-1', title: 'Cats' },
    ];
    writeSignals([tagged, signal('obs-cat2', 'Another cat note Katze', '2026-06-01T11:00:00Z')]);

    const hits = await recallSemantic(
      WS,
      { text: 'Katze', anchor: { type: 'feature', id: 'f-1' } },
      { embedder: mockEmbedder() },
      clock,
    );
    expect(hits.length).toBe(1);
    expect(hits[0]!.summary).toContain('asleep');
    expect(hits[0]!.matched).toContain('anchor');
  });

  it('persists embeddings as a side effect so the next call hits the cache', async () => {
    writeSignals([signal('obs-cat', 'cat content', '2026-06-01T10:00:00Z')]);
    const embedder = mockEmbedder();

    await recallSemantic(WS, { text: 'Katze' }, { embedder }, clock);
    const batchesAfterFirst = embedder.calls.length;
    await recallSemantic(WS, { text: 'Katze' }, { embedder }, clock);
    // Second call adds exactly one batch: the query itself. Passages cached.
    expect(embedder.calls.length).toBe(batchesAfterFirst + 1);

    const raw = JSON.parse(readFileSync(getVectorSidecarPath(SESSION_DIR), 'utf-8'));
    expect(Object.keys(raw.entries)).toContain('obs-cat');
  });
});
