/**
 * Vector sidecar — per-session embedding cache for observation signals.
 *
 * Lives next to the evidence sidecar as `data/observations-embeddings.json`,
 * keyed by the same stable observation IDs (`obs-<shortId>`) the loader
 * produces. The Markdown ledger stays the single source of truth for content;
 * this file is a derived cache and can be deleted at any time — it is rebuilt
 * lazily on the next semantic recall or by `scripts/orcha-embed-observations.ts`.
 *
 * Staleness is tracked per entry via a content hash of the embedded text, and
 * per file via the model id: a model/dimension change discards the whole cache
 * (re-embedding is cheap at observation scale; mixing vector spaces is not).
 *
 * Deliberately JSON with rounded floats, not a binary format: at 384 dims and
 * a few hundred observations per session the file stays in the tens of KB,
 * stays diffable, and needs no new parser. Revisit only if measurements demand.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { Embedder } from './embedder.ts';
import type { ObservationSignal } from './observation-watermark.ts';

export interface VectorSidecarFile {
  model: string;
  dim: number;
  entries: Record<string, { hash: string; v: number[] }>;
}

export function getVectorSidecarPath(sessionDir: string): string {
  return join(sessionDir, 'data', 'observations-embeddings.json');
}

/** The text a signal is embedded from — same haystack `textScore` matches on. */
export function embeddingTextFor(sig: ObservationSignal): string {
  return `${sig.summary}\n${sig.conversation?.excerpt ?? ''}`.trim();
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function loadVectorSidecar(sessionDir: string): VectorSidecarFile | null {
  const path = getVectorSidecarPath(sessionDir);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    if (!raw || typeof raw !== 'object' || typeof raw.model !== 'string') return null;
    return raw as VectorSidecarFile;
  } catch {
    return null;
  }
}

/** Round to 6 decimals — float32 noise adds nothing, file size does. */
function compactVector(v: Float32Array): number[] {
  return Array.from(v, (x) => Math.round(x * 1e6) / 1e6);
}

/**
 * Return embeddings for `signals`, embedding only what is missing or stale and
 * persisting the updated sidecar. This is the single write path for the cache
 * (the recall engine itself stays read-only by delegating here).
 *
 * Best-effort by contract: a failed write keeps the in-memory result valid; a
 * failed embed batch throws so the caller can fall back to text scoring for
 * that session without partial state.
 */
export async function ensureEmbeddings(
  sessionDir: string,
  signals: ObservationSignal[],
  embedder: Embedder,
): Promise<Map<string, Float32Array>> {
  const existing = loadVectorSidecar(sessionDir);
  // Model or dimension change invalidates the whole cache: vectors from
  // different spaces must never be compared.
  const reusable =
    existing && existing.model === embedder.model && existing.dim === embedder.dim
      ? existing.entries
      : {};

  const result = new Map<string, Float32Array>();
  const missing: Array<{ id: string; hash: string; text: string }> = [];

  for (const sig of signals) {
    const text = embeddingTextFor(sig);
    if (!text) continue;
    const hash = hashText(text);
    const entry = reusable[sig.id];
    if (entry && entry.hash === hash && entry.v.length === embedder.dim) {
      result.set(sig.id, Float32Array.from(entry.v));
    } else {
      missing.push({ id: sig.id, hash, text });
    }
  }

  if (missing.length === 0) return result;

  const vectors = await embedder.embed(
    missing.map((m) => m.text),
    'passage',
  );

  const entries: VectorSidecarFile['entries'] = {};
  // Keep only entries for signals we still see — pruned bullets drop out.
  // Everything already in `result` came from `reusable` by construction.
  for (const id of result.keys()) {
    const prev = reusable[id];
    if (prev) entries[id] = prev;
  }
  for (let i = 0; i < missing.length; i++) {
    const m = missing[i]!;
    const v = vectors[i];
    if (!v) continue;
    result.set(m.id, v);
    entries[m.id] = { hash: m.hash, v: compactVector(v) };
  }

  const file: VectorSidecarFile = { model: embedder.model, dim: embedder.dim, entries };
  try {
    const path = getVectorSidecarPath(sessionDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(file), 'utf-8');
  } catch {
    // Cache write failure is non-fatal — vectors are still returned in-memory.
  }

  return result;
}
