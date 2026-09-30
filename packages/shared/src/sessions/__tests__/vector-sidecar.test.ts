import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Embedder } from '../embedder.ts';
import { cosineSimilarity, embedInBatches } from '../embedder.ts';
import {
  ensureEmbeddings,
  embeddingHash,
  getVectorSidecarPath,
  loadVectorSidecar,
  lookupEmbeddings,
  embeddingTextFor,
} from '../vector-sidecar.ts';
import { findSessionsNeedingEmbeddings, indexSessionEmbeddings } from '../embed-index.ts';
import { recallSemantic, recallSemanticDetailed } from '../recall-engine.ts';
import type { ObservationSignal } from '../observation-watermark.ts';

const WS = join(import.meta.dir, '__test_vector_sidecar_ws__');
const SESSION_ID = 'sess-1';
const SESSION_DIR = join(WS, 'sessions', SESSION_ID);

/**
 * Deterministic keyword embedder (dim 3, normalised axes): texts about cats,
 * dogs, and everything else land on orthogonal vectors, so similarity is
 * exactly 1 for a topic match and 0 otherwise. `calls` records every embed
 * call (with its kind) to assert cache and read-only behaviour.
 */
function mockEmbedder(model = 'mock-v1'): Embedder & {
  calls: Array<{ texts: string[]; kind: string }>;
  indexRequests: string[][];
} {
  const calls: Array<{ texts: string[]; kind: string }> = [];
  const indexRequests: string[][] = [];
  return {
    model,
    dim: 3,
    calls,
    indexRequests,
    async embed(texts, kind) {
      calls.push({ texts: [...texts], kind });
      return texts.map((t) => {
        const s = t.toLowerCase();
        if (s.includes('katze') || s.includes('cat')) return Float32Array.from([1, 0, 0]);
        if (s.includes('hund') || s.includes('dog')) return Float32Array.from([0, 1, 0]);
        return Float32Array.from([0, 0, 1]);
      });
    },
    requestIndex(dirs) {
      indexRequests.push([...dirs]);
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

function writeSignals(signals: ObservationSignal[], dir = SESSION_DIR): void {
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data', 'observations.json'), JSON.stringify(signals), 'utf-8');
}

const passageCalls = (e: ReturnType<typeof mockEmbedder>) => e.calls.filter((c) => c.kind === 'passage');

beforeEach(() => {
  if (existsSync(WS)) rmSync(WS, { recursive: true });
  mkdirSync(join(SESSION_DIR, 'data'), { recursive: true });
});

afterEach(() => {
  if (existsSync(WS)) rmSync(WS, { recursive: true });
});

describe('embedInBatches', () => {
  it('splits into fixed-size runs and preserves order', async () => {
    const seen: number[] = [];
    const texts = Array.from({ length: 37 }, (_, i) => `t${i}`);
    const out = await embedInBatches(texts, 16, async (batch) => {
      seen.push(batch.length);
      return batch.map((t) => Float32Array.from([Number(t.slice(1))]));
    });
    expect(seen).toEqual([16, 16, 5]);
    expect(out.map((v) => v[0])).toEqual(texts.map((_, i) => i));
  });
});

describe('ensureEmbeddings (content-addressed v2)', () => {
  it('embeds missing texts, persists v2, and reuses it on re-run', async () => {
    const embedder = mockEmbedder();
    const signals = [
      signal('obs-a', 'Die Katze schläft', '2026-06-01T10:00:00Z'),
      signal('obs-b', 'Der Hund bellt', '2026-06-01T11:00:00Z'),
    ];

    const first = await ensureEmbeddings(SESSION_DIR, signals, embedder);
    expect(first.size).toBe(2);
    expect(embedder.calls.length).toBe(1);
    const raw = JSON.parse(readFileSync(getVectorSidecarPath(SESSION_DIR), 'utf-8'));
    expect(raw.version).toBe(2);
    expect(Object.keys(raw.vectors).sort()).toEqual(signals.map((s) => embeddingHash(embeddingTextFor(s))).sort());

    const second = await ensureEmbeddings(SESSION_DIR, signals, embedder);
    expect(second.size).toBe(2);
    expect(embedder.calls.length).toBe(1); // nothing re-embedded
    expect(cosineSimilarity(second.get('obs-a')!, Float32Array.from([1, 0, 0]))).toBeCloseTo(1);
  });

  it('survives ID changes and reorders (reflection) without re-embedding', async () => {
    const embedder = mockEmbedder();
    await ensureEmbeddings(
      SESSION_DIR,
      [signal('obs-mastra-0', 'Die Katze schläft', '2026-06-01T10:00:00Z'), signal('obs-mastra-1', 'Der Hund bellt', '2026-06-01T11:00:00Z')],
      embedder,
    );
    // Same texts, shifted positional IDs — as after a reflection pass.
    const shifted = [
      signal('obs-mastra-0', 'Der Hund bellt', '2026-06-01T11:00:00Z'),
      signal('obs-mastra-1', 'Die Katze schläft', '2026-06-01T10:00:00Z'),
    ];
    const result = await ensureEmbeddings(SESSION_DIR, shifted, embedder);
    expect(embedder.calls.length).toBe(1);
    expect(cosineSimilarity(result.get('obs-mastra-1')!, Float32Array.from([1, 0, 0]))).toBeCloseTo(1);
  });

  it('embeds only changed text and prunes vectors of removed bullets', async () => {
    const embedder = mockEmbedder();
    await ensureEmbeddings(SESSION_DIR, [signal('obs-a', 'Die Katze schläft', '2026-06-01T10:00:00Z')], embedder);

    const v2 = [signal('obs-a', 'Der Hund bellt jetzt', '2026-06-01T10:00:00Z')];
    const result = await ensureEmbeddings(SESSION_DIR, v2, embedder);
    expect(embedder.calls.length).toBe(2);
    expect(embedder.calls[1]!.texts).toEqual([embeddingTextFor(v2[0]!)]);
    expect(cosineSimilarity(result.get('obs-a')!, Float32Array.from([0, 1, 0]))).toBeCloseTo(1);
    expect(Object.keys(loadVectorSidecar(SESSION_DIR)!.vectors)).toEqual([embeddingHash(embeddingTextFor(v2[0]!))]);
  });

  it('deduplicates identical texts into one embedding', async () => {
    const embedder = mockEmbedder();
    await ensureEmbeddings(
      SESSION_DIR,
      [signal('obs-a', 'Die Katze', '2026-06-01T10:00:00Z'), signal('obs-b', 'Die Katze', '2026-06-01T11:00:00Z')],
      embedder,
    );
    expect(embedder.calls[0]!.texts.length).toBe(1);
  });

  it('persists per chunk so an interrupted run keeps its progress', async () => {
    const signals = Array.from({ length: 5 }, (_, i) => signal(`obs-${i}`, `note ${i}`, '2026-06-01T10:00:00Z'));
    let calls = 0;
    const failing: Embedder = {
      model: 'mock-v1',
      dim: 3,
      async embed(texts) {
        if (++calls === 2) throw new Error('boom');
        return texts.map(() => Float32Array.from([0, 0, 1]));
      },
    };
    await expect(ensureEmbeddings(SESSION_DIR, signals, failing, { persistChunk: 2 })).rejects.toThrow('boom');
    expect(Object.keys(loadVectorSidecar(SESSION_DIR)!.vectors).length).toBe(2);

    const resume = mockEmbedder();
    await ensureEmbeddings(SESSION_DIR, signals, resume, { persistChunk: 2 });
    expect(resume.calls.flatMap((c) => c.texts).length).toBe(3); // only the rest
  });

  it('discards the whole cache when the model changes', async () => {
    const signals = [signal('obs-a', 'Die Katze schläft', '2026-06-01T10:00:00Z')];
    await ensureEmbeddings(SESSION_DIR, signals, mockEmbedder('model-a'));

    const next = mockEmbedder('model-b');
    await ensureEmbeddings(SESSION_DIR, signals, next);
    expect(next.calls.length).toBe(1);
    expect(loadVectorSidecar(SESSION_DIR)?.model).toBe('model-b');
  });

  it('survives a corrupt sidecar file and writes atomically (no tmp left)', async () => {
    writeFileSync(getVectorSidecarPath(SESSION_DIR), '{not json', 'utf-8');
    const embedder = mockEmbedder();
    const result = await ensureEmbeddings(
      SESSION_DIR,
      [signal('obs-a', 'Die Katze schläft', '2026-06-01T10:00:00Z')],
      embedder,
    );
    expect(result.size).toBe(1);
    expect(loadVectorSidecar(SESSION_DIR)?.model).toBe('mock-v1');
    expect(readdirSync(join(SESSION_DIR, 'data')).some((f) => f.endsWith('.tmp'))).toBe(false);
  });
});

describe('v1 migration and read-only lookup', () => {
  it('reads a legacy ID-keyed sidecar by hash without re-embedding', async () => {
    const sig = signal('obs-old-id', 'Die Katze schläft', '2026-06-01T10:00:00Z');
    writeFileSync(
      getVectorSidecarPath(SESSION_DIR),
      JSON.stringify({
        model: 'mock-v1',
        dim: 3,
        entries: { 'some-other-id': { hash: embeddingHash(embeddingTextFor(sig)), v: [1, 0, 0] } },
      }),
      'utf-8',
    );
    const { vectors, missing } = lookupEmbeddings(SESSION_DIR, [sig], { model: 'mock-v1', dim: 3 });
    expect(missing).toBe(0);
    expect(cosineSimilarity(vectors.get('obs-old-id')!, Float32Array.from([1, 0, 0]))).toBeCloseTo(1);

    const embedder = mockEmbedder();
    await ensureEmbeddings(SESSION_DIR, [sig], embedder);
    expect(embedder.calls.length).toBe(0);
  });

  it('lookup never writes and reports missing vectors', () => {
    const { vectors, missing } = lookupEmbeddings(
      SESSION_DIR,
      [signal('obs-a', 'Die Katze', '2026-06-01T10:00:00Z')],
      { model: 'mock-v1', dim: 3 },
    );
    expect(vectors.size).toBe(0);
    expect(missing).toBe(1);
    expect(existsSync(getVectorSidecarPath(SESSION_DIR))).toBe(false);
  });
});

describe('embed-index', () => {
  it('finds sessions with a backlog and indexes them', async () => {
    writeSignals([signal('obs-a', 'Die Katze schläft', '2026-06-01T10:00:00Z')]);
    const otherDir = join(WS, 'sessions', 'sess-empty');
    mkdirSync(otherDir, { recursive: true });

    const identity = { model: 'mock-v1', dim: 3 };
    expect(findSessionsNeedingEmbeddings([WS], identity)).toEqual([SESSION_DIR]);

    const embedded = await indexSessionEmbeddings(SESSION_DIR, mockEmbedder());
    expect(embedded).toBe(1);
    expect(findSessionsNeedingEmbeddings([WS], identity)).toEqual([]);
  });
});

describe('recallSemantic (read-only on the vector side)', () => {
  const clock = () => Date.parse('2026-06-02T00:00:00Z');

  it('ranks by embedding similarity once the session is indexed', async () => {
    const signals = [
      // Different wording than the query — token overlap is zero, only the
      // embedding axis can find it.
      signal('obs-cat', 'Feline asleep on the sofa cat', '2026-06-01T10:00:00Z'),
      signal('obs-dog', 'Der Hund bellt laut', '2026-06-01T11:00:00Z'),
    ];
    writeSignals(signals);
    const embedder = mockEmbedder();
    await indexSessionEmbeddings(SESSION_DIR, embedder);

    const hits = await recallSemantic(WS, { text: 'Katze' }, { embedder }, clock);
    expect(hits.length).toBe(1); // dog scores 0 similarity + 0 overlap → dropped
    expect(hits[0]!.summary).toContain('Feline');
    expect(hits[0]!.matched).toContain('semantic');
    expect(hits[0]!.messageRange.from).toBe('msg-obs-cat');
  });

  it('never embeds passages: unindexed sessions score by text and are queued for indexing', async () => {
    writeSignals([
      signal('obs-cat', 'Feline asleep cat', '2026-06-01T10:00:00Z'),
      signal('obs-katze', 'Die Katze schläft', '2026-06-01T11:00:00Z'),
    ]);
    const embedder = mockEmbedder();

    const { hits, coverage } = await recallSemanticDetailed(WS, { text: 'Katze' }, { embedder }, clock);
    expect(passageCalls(embedder).length).toBe(0); // only the query was embedded
    expect(embedder.calls.length).toBe(1);
    expect(hits.map((h) => h.summary)).toEqual(['Die Katze schläft']); // text match only
    expect(hits[0]!.matched).toContain('text');
    expect(coverage).toEqual({ observations: 2, vectorized: 0, indexingRequested: 1 });
    expect(embedder.indexRequests).toEqual([[SESSION_DIR]]);
    expect(existsSync(getVectorSidecarPath(SESSION_DIR))).toBe(false);
  });

  it('does not request indexing when every vector is cached', async () => {
    writeSignals([signal('obs-cat', 'cat content', '2026-06-01T10:00:00Z')]);
    const embedder = mockEmbedder();
    await indexSessionEmbeddings(SESSION_DIR, embedder);

    const { coverage } = await recallSemanticDetailed(WS, { text: 'Katze' }, { embedder }, clock);
    expect(coverage).toEqual({ observations: 1, vectorized: 1, indexingRequested: 0 });
    expect(embedder.indexRequests).toEqual([]);
  });

  it('falls back to text-overlap recall when no embedder is available', async () => {
    writeSignals([signal('obs-a', 'Die Katze schläft', '2026-06-01T10:00:00Z')]);

    const { hits, coverage } = await recallSemanticDetailed(WS, { text: 'Katze' }, { embedder: null }, clock);
    expect(hits.length).toBe(1);
    expect(hits[0]!.matched).toContain('text');
    expect(hits[0]!.matched).not.toContain('semantic');
    expect(coverage).toBeUndefined();
  });

  it('falls back to text recall when the query embedding fails (worker crashed)', async () => {
    writeSignals([signal('obs-a', 'Die Katze schläft', '2026-06-01T10:00:00Z')]);
    const crashed: Embedder = {
      model: 'mock-v1',
      dim: 3,
      async embed() {
        throw new Error('embed worker exited (code=null, signal=SIGKILL)');
      },
    };
    const hits = await recallSemantic(WS, { text: 'Katze' }, { embedder: crashed }, clock);
    expect(hits.length).toBe(1);
    expect(hits[0]!.matched).toContain('text');
  });

  it('keeps anchors as a hard filter on top of semantic scoring', async () => {
    const tagged = signal('obs-cat', 'Feline asleep cat', '2026-06-01T10:00:00Z');
    (tagged as { anchorRefs?: unknown[] }).anchorRefs = [
      { type: 'feature', id: 'f-1', title: 'Cats' },
    ];
    writeSignals([tagged, signal('obs-cat2', 'Another cat note Katze', '2026-06-01T11:00:00Z')]);
    const embedder = mockEmbedder();
    await indexSessionEmbeddings(SESSION_DIR, embedder);

    const hits = await recallSemantic(
      WS,
      { text: 'Katze', anchor: { type: 'feature', id: 'f-1' } },
      { embedder },
      clock,
    );
    expect(hits.length).toBe(1);
    expect(hits[0]!.summary).toContain('asleep');
    expect(hits[0]!.matched).toContain('anchor');
  });
});
