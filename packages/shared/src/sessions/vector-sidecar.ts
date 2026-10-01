/**
 * Vector sidecar — per-session embedding cache for observation signals.
 *
 * Lives next to the evidence sidecar as `data/observations-embeddings.json`.
 * The Markdown ledger stays the single source of truth for content; this file
 * is a derived cache and can be deleted at any time — it is rebuilt by the
 * embed worker (see `embed-client.ts`) or `scripts/orcha-embed-observations.ts`.
 *
 * v2 is CONTENT-ADDRESSED: vectors are keyed by a hash of the embedded text,
 * not by observation ID. Unanchored bullets get positional IDs
 * (`obs-mastra-<index>`), so an ID-keyed cache (v1) was invalidated by every
 * reflection/reorder and by ID-scheme changes — 1,306 of the workspace's
 * vectors were "missing" that way on 2026-09-30. With hash keys, only text
 * that is genuinely new costs an embedding. v1 files are migrated on read
 * without re-embedding.
 *
 * A model/dimension change discards the whole cache (mixing vector spaces is
 * never valid). Deliberately JSON with rounded floats: a few hundred vectors
 * per session stay in the tens-to-hundreds of KB and need no new parser.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { Embedder } from './embedder.ts';
import type { ObservationSignal } from './observation-watermark.ts';

export interface VectorSidecarFile {
  version: 2;
  model: string;
  dim: number;
  /** textHash → rounded vector. */
  vectors: Record<string, number[]>;
}

/** Legacy ID-keyed shape (pre 2026-09-30). Read-only, migrated on load. */
interface VectorSidecarFileV1 {
  model: string;
  dim: number;
  entries: Record<string, { hash: string; v: number[] }>;
}

export interface EmbedModelIdentity {
  model: string;
  dim: number;
}

/** Texts embedded (and persisted) per step — progress survives a crash/kill. */
export const DEFAULT_PERSIST_CHUNK = 64;

export function getVectorSidecarPath(sessionDir: string): string {
  return join(sessionDir, 'data', 'observations-embeddings.json');
}

/** The text a signal is embedded from — same haystack `textScore` matches on. */
export function embeddingTextFor(sig: ObservationSignal): string {
  return `${sig.summary}\n${sig.conversation?.excerpt ?? ''}`.trim();
}

export function embeddingHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Load the sidecar in v2 shape (v1 migrated in memory); null if absent/corrupt. */
export function loadVectorSidecar(sessionDir: string): VectorSidecarFile | null {
  const path = getVectorSidecarPath(sessionDir);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<VectorSidecarFile & VectorSidecarFileV1>;
    if (!raw || typeof raw !== 'object' || typeof raw.model !== 'string' || typeof raw.dim !== 'number') {
      return null;
    }
    if (raw.version === 2 && raw.vectors && typeof raw.vectors === 'object') {
      return { version: 2, model: raw.model, dim: raw.dim, vectors: raw.vectors };
    }
    if (raw.entries && typeof raw.entries === 'object') {
      const vectors: Record<string, number[]> = {};
      for (const entry of Object.values(raw.entries)) {
        if (entry && typeof entry.hash === 'string' && Array.isArray(entry.v)) vectors[entry.hash] = entry.v;
      }
      return { version: 2, model: raw.model, dim: raw.dim, vectors };
    }
    return null;
  } catch {
    return null;
  }
}

function usableVectors(file: VectorSidecarFile | null, identity: EmbedModelIdentity): Record<string, number[]> {
  return file && file.model === identity.model && file.dim === identity.dim ? file.vectors : {};
}

/**
 * READ-ONLY lookup: vectors for the signals that already have one, plus how
 * many are missing. Never embeds, never writes — safe on any hot path.
 */
export function lookupEmbeddings(
  sessionDir: string,
  signals: ObservationSignal[],
  identity: EmbedModelIdentity,
): { vectors: Map<string, Float32Array>; missing: number } {
  const known = usableVectors(loadVectorSidecar(sessionDir), identity);
  const vectors = new Map<string, Float32Array>();
  let missing = 0;
  for (const sig of signals) {
    const text = embeddingTextFor(sig);
    if (!text) continue;
    const v = known[embeddingHash(text)];
    if (v && v.length === identity.dim) vectors.set(sig.id, Float32Array.from(v));
    else missing++;
  }
  return { vectors, missing };
}

/** Round to 6 decimals — float32 noise adds nothing, file size does. */
function compactVector(v: Float32Array): number[] {
  return Array.from(v, (x) => Math.round(x * 1e6) / 1e6);
}

/**
 * Persist `vectors` restricted to `keep` hashes. Re-reads the file first and
 * merges same-model vectors written meanwhile (best-effort against a second
 * writer), then replaces the file atomically (tmp + rename) so readers never
 * see a half-written JSON.
 */
function persist(
  sessionDir: string,
  identity: EmbedModelIdentity,
  vectors: Record<string, number[]>,
  keep: Set<string>,
): void {
  const merged: Record<string, number[]> = {};
  const onDisk = usableVectors(loadVectorSidecar(sessionDir), identity);
  for (const hash of keep) {
    const v = vectors[hash] ?? onDisk[hash];
    if (v) merged[hash] = v;
  }
  const file: VectorSidecarFile = { version: 2, model: identity.model, dim: identity.dim, vectors: merged };
  try {
    const path = getVectorSidecarPath(sessionDir);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(file), 'utf-8');
    renameSync(tmp, path);
  } catch {
    // Cache write failure is non-fatal — vectors are still returned in-memory.
  }
}

/**
 * Return embeddings for `signals`, embedding only texts whose hash has no
 * vector yet, and persist the sidecar after every `persistChunk` texts. This
 * is the single write path for the cache. It loads ONNX via `embedder`, so it
 * must only run in a child process (embed worker / backfill script).
 *
 * A failed embed throws after the chunks before it were persisted, so an
 * interrupted backfill resumes where it stopped instead of starting over.
 */
export async function ensureEmbeddings(
  sessionDir: string,
  signals: ObservationSignal[],
  embedder: Embedder,
  opts: { persistChunk?: number } = {},
): Promise<Map<string, Float32Array>> {
  const identity = { model: embedder.model, dim: embedder.dim };
  const known = { ...usableVectors(loadVectorSidecar(sessionDir), identity) };

  const keep = new Set<string>();
  const hashById = new Map<string, string>();
  const todo = new Map<string, string>(); // hash → text (deduplicated)
  for (const sig of signals) {
    const text = embeddingTextFor(sig);
    if (!text) continue;
    const hash = embeddingHash(text);
    keep.add(hash);
    hashById.set(sig.id, hash);
    const v = known[hash];
    if (!(v && v.length === identity.dim)) todo.set(hash, text);
  }

  const pending = [...todo.entries()];
  const chunk = opts.persistChunk ?? DEFAULT_PERSIST_CHUNK;
  let prunable = pending.length === 0 && Object.keys(known).some((h) => !keep.has(h));
  for (let i = 0; i < pending.length; i += chunk) {
    const slice = pending.slice(i, i + chunk);
    const vectors = await embedder.embed(slice.map(([, text]) => text), 'passage');
    slice.forEach(([hash], j) => {
      const v = vectors[j];
      if (v) known[hash] = compactVector(v);
    });
    persist(sessionDir, identity, known, keep);
    prunable = false;
  }
  // Nothing new but stale vectors present (bullets pruned by reflection):
  // rewrite once so the file doesn't grow without bound.
  if (prunable) persist(sessionDir, identity, known, keep);

  const result = new Map<string, Float32Array>();
  for (const [id, hash] of hashById) {
    const v = known[hash];
    if (v) result.set(id, Float32Array.from(v));
  }
  return result;
}
