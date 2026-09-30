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
 * Process placement: ONNX runs only in child processes — the long-lived embed
 * worker (`scripts/orcha-embed-worker.ts`, driven by `embed-client.ts`) and the
 * backfill script. The app process never loads it (see `resolveEmbedder`).
 *
 * IMPORTANT (bundling): the worker is built with esbuild `--bundle` (see
 * `build:observers`). `@huggingface/transformers` ships native ONNX binaries that must
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
  /**
   * Optional: ask the provider to (re)index these session dirs in the
   * background. Implemented by the embed-worker client; recall uses it to
   * backfill sessions it had to score by text only.
   */
  requestIndex?(sessionDirs: string[]): void;
  /** Optional: release native resources (ONNX sessions) before process exit. */
  dispose?(): Promise<void>;
}

export const DEFAULT_EMBED_MODEL = 'Xenova/multilingual-e5-small';
export const DEFAULT_EMBED_DIM = 384;

/**
 * Texts per ONNX run. The attention tensors scale with batch × seq², so one
 * run over a whole session's backlog (307 passages) peaked at 5.1 GB RSS and
 * crashed the Electron main process (2026-09-30). 16 keeps the transient
 * working set around a few hundred MB. Override: ORCHA_EMBED_BATCH.
 */
export const DEFAULT_EMBED_BATCH = 16;

/**
 * Cheap pre-cut before tokenisation. The pipeline already truncates to the
 * model's 512 tokens; this only avoids tokenising megabyte-sized excerpts.
 */
export const MAX_EMBED_CHARS = 2_000;

/** Model identity from env — shared by the in-process embedder and the worker client. */
export function resolveEmbedConfig(): { model: string; dim: number } {
  return {
    model: process.env.ORCHA_EMBED_MODEL ?? DEFAULT_EMBED_MODEL,
    dim: Number(process.env.ORCHA_EMBED_DIM ?? DEFAULT_EMBED_DIM),
  };
}

export function resolveEmbedBatchSize(): number {
  const v = parseInt(process.env.ORCHA_EMBED_BATCH ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_EMBED_BATCH;
}

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
  dispose?(): Promise<void>;
}

let cached: Promise<Embedder | null> | undefined;

/**
 * Resolve the IN-PROCESS embedding provider (loads ONNX into the calling
 * process). Memoised: the model pipeline loads once per process.
 * Returns null when disabled, when the package is absent, or when the model
 * fails to load — callers must treat null as "semantic recall unavailable".
 *
 * Only for child processes (embed worker, backfill script). The app process
 * must use `getEmbedClient()` from `embed-client.ts` instead — a native ONNX
 * failure in the Electron main process takes the whole app down.
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
  const { model, dim } = resolveEmbedConfig();

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

  const prefix = (kind: EmbedKind) => prefixFor(model, kind);
  return {
    model,
    dim,
    embed: (texts, kind) =>
      embedInBatches(texts, resolveEmbedBatchSize(), async (batch) => {
        const output = await extractor(
          batch.map((t) => prefix(kind) + t.slice(0, MAX_EMBED_CHARS)),
          { pooling: 'mean', normalize: true },
        );
        return output.tolist().map((row) => Float32Array.from(row));
      }),
    // Exiting with live ONNX sessions aborts in onnxruntime's static
    // destructors (SIGABRT + a macOS crash report) — release them first.
    dispose: async () => {
      await extractor.dispose?.();
    },
  };
}

/**
 * Run `runBatch` over `texts` in fixed-size slices, preserving order, and
 * yield to the event loop between slices so a large backlog never becomes
 * one monolithic ONNX run (memory) or one monolithic block (latency).
 */
export async function embedInBatches(
  texts: string[],
  batchSize: number,
  runBatch: (batch: string[]) => Promise<Float32Array[]>,
): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    if (i > 0) await new Promise<void>((r) => setImmediate(r));
    const vectors = await runBatch(texts.slice(i, i + batchSize));
    out.push(...vectors);
  }
  return out;
}

/** Cosine similarity of two L2-normalised vectors (plain dot product). */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}
