/**
 * Embedder — local-first text-embedding provider for semantic recall.
 *
 * Mirrors the resolver pattern of `scripts/lib/llm-extractor.ts`: a single
 * `resolveEmbedder()` that inspects the environment and returns a usable
 * provider or null, so every caller degrades identically (recall falls back to
 * token-overlap scoring, never errors).
 *
 * Default provider is Transformers.js running fully on-device — no API key, no
 * network after the first model download (cached under the HF cache dir). The
 * model defaults to multilingual-e5-small because Orcha observations mix
 * German and English; E5 models expect "query: " / "passage: " prefixes, which
 * `embed()` applies based on `kind`.
 *
 * IMPORTANT (bundling): the Electron main process is built with esbuild
 * `--bundle`. `@huggingface/transformers` ships native ONNX binaries that must
 * NOT be inlined, so the import below uses a non-literal specifier — esbuild
 * leaves it as a runtime require. If the package is missing at runtime the
 * resolver returns null and recall stays text-based.
 *
 * Env:
 *   ORCHA_EMBED_DISABLE=1   — force-disable semantic recall
 *   ORCHA_EMBED_MODEL       — HF model id (default Xenova/multilingual-e5-small)
 *   ORCHA_EMBED_DIM         — embedding dimension (default 384)
 *   ORCHA_EMBED_CACHE_DIR   — on-disk model cache (default ~/.orcha-agents/models)
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export type EmbedKind = 'query' | 'passage';

export interface Embedder {
  /** Model identifier — persisted in sidecars so stale vectors are detected. */
  model: string;
  /** Embedding dimension (for sidecar validation). */
  dim: number;
  /** Embed texts into L2-normalised vectors (dot product == cosine). */
  embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]>;
}

export const DEFAULT_EMBED_MODEL = 'Xenova/multilingual-e5-small';
export const DEFAULT_EMBED_DIM = 384;

/**
 * Canonical on-disk model cache. Shared by dev and the packaged app (both
 * resolve `~/.orcha-agents`), so a model downloaded once — or pre-seeded by
 * `scripts/orcha-embed-observations.ts` — is reused everywhere, offline.
 */
export function embedCacheDir(): string {
  return process.env.ORCHA_EMBED_CACHE_DIR ?? join(homedir(), '.orcha-agents', 'models');
}

/** E5-family models are trained with these prefixes; others ignore them. */
function prefixFor(model: string, kind: EmbedKind): string {
  return /e5/i.test(model) ? `${kind}: ` : '';
}

interface FeatureExtractor {
  (texts: string[], opts: { pooling: 'mean'; normalize: boolean }): Promise<{
    tolist(): number[][];
  }>;
}

let cached: Promise<Embedder | null> | undefined;

/**
 * Resolve the embedding provider. Memoised: the model pipeline loads once per
 * process and is reused across all recall calls and sidecar refreshes.
 * Returns null when disabled, when the package is absent, or when the model
 * fails to load — callers must treat null as "semantic recall unavailable".
 */
export function resolveEmbedder(): Promise<Embedder | null> {
  if (cached === undefined) cached = doResolve();
  return cached;
}

/** Test seam: replace or clear the memoised provider. */
export function setEmbedderForTesting(embedder: Embedder | null | undefined): void {
  cached = embedder === undefined ? undefined : Promise.resolve(embedder);
}

async function doResolve(): Promise<Embedder | null> {
  if (process.env.ORCHA_EMBED_DISABLE === '1') return null;
  const model = process.env.ORCHA_EMBED_MODEL ?? DEFAULT_EMBED_MODEL;
  const dim = Number(process.env.ORCHA_EMBED_DIM ?? DEFAULT_EMBED_DIM);

  let extractor: FeatureExtractor;
  try {
    // Non-literal specifier: keeps esbuild/vite from bundling the native deps.
    const specifier = '@huggingface/transformers';
    const mod = (await import(specifier)) as {
      pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<unknown>;
      env?: { cacheDir?: string; allowRemoteModels?: boolean };
    };
    // Pin the on-disk cache so dev and the packaged app share one warm copy.
    if (mod.env) {
      mod.env.cacheDir = embedCacheDir();
      mod.env.allowRemoteModels = true; // download once if the cache is cold
    }
    extractor = (await mod.pipeline('feature-extraction', model, {
      dtype: 'q8',
    })) as unknown as FeatureExtractor;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Embedder: local model unavailable, semantic recall disabled (${message})`);
    return null;
  }

  return {
    model,
    dim,
    async embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const prefix = prefixFor(model, kind);
      const output = await extractor(
        texts.map((t) => prefix + t),
        { pooling: 'mean', normalize: true },
      );
      return output.tolist().map((row) => Float32Array.from(row));
    },
  };
}

/** Cosine similarity of two L2-normalised vectors (plain dot product). */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}
