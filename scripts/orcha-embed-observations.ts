#!/usr/bin/env bun
/**
 * Orcha Embed Observations — backfill the per-session vector sidecars
 * (`data/observations-embeddings.json`) so semantic recall has embeddings for
 * sessions recorded before the feature existed (or after deleting the caches).
 *
 * Idempotent: `ensureEmbeddings` hashes the embedded text per observation and
 * re-embeds only missing/stale entries, so re-running is cheap. The Markdown
 * ledgers are never written — the sidecar is a derived cache.
 *
 * CLI:
 *   orcha-embed-observations <workspaceRootPath | sessionsDir> [--dry-run]
 *
 *   The argument may be a workspace root (containing `sessions/`) or a
 *   sessions directory itself; single session dirs work too.
 *
 * Exit codes:
 *   0  ok
 *   1  bad args / missing directory
 *   2  no embedder available (package missing or ORCHA_EMBED_DISABLE=1)
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { resolveEmbedder } from '../packages/shared/src/sessions/embedder.ts';
import { loadObservationSignals } from '../packages/shared/src/sessions/observation-loader.ts';
import {
  ensureEmbeddings,
  loadVectorSidecar,
  embeddingTextFor,
} from '../packages/shared/src/sessions/vector-sidecar.ts';

function usage(): never {
  console.error('Usage: orcha-embed-observations <workspaceRootPath|sessionsDir> [--dry-run]');
  process.exit(1);
}

const rootArg = process.argv[2];
if (!rootArg || rootArg.startsWith('--')) usage();
const root = rootArg.replace(/^~/, process.env.HOME ?? '~');
if (!existsSync(root)) {
  console.error(`Directory not found: ${root}`);
  process.exit(1);
}
const dryRun = process.argv.includes('--dry-run');

/** Accept a workspace root, a sessions dir, or a single session dir. */
function resolveSessionDirs(path: string): string[] {
  if (existsSync(join(path, 'data')) || existsSync(join(path, 'session.jsonl'))) {
    return [path]; // single session
  }
  const sessionsDir = existsSync(join(path, 'sessions')) ? join(path, 'sessions') : path;
  try {
    return readdirSync(sessionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(sessionsDir, e.name));
  } catch {
    return [];
  }
}

const sessionDirs = resolveSessionDirs(root);
if (sessionDirs.length === 0) {
  console.error(`No session directories found under: ${root}`);
  process.exit(1);
}

const embedder = await resolveEmbedder();
if (!embedder) {
  console.error('No embedder available (package missing or ORCHA_EMBED_DISABLE=1).');
  process.exit(2);
}
console.log(`Embedder: ${embedder.model} (dim ${embedder.dim}) — ${sessionDirs.length} session(s)`);

let totalSignals = 0;
let totalEmbedded = 0;
let totalCached = 0;

for (const dir of sessionDirs) {
  const id = basename(dir);
  let signals;
  try {
    signals = loadObservationSignals(dir);
  } catch {
    continue;
  }
  const embeddable = signals.filter((s) => embeddingTextFor(s).length > 0);
  if (embeddable.length === 0) continue;
  totalSignals += embeddable.length;

  const existing = loadVectorSidecar(dir);
  const cachedCount =
    existing && existing.model === embedder.model ? Object.keys(existing.entries).length : 0;

  if (dryRun) {
    console.log(`  ${id}: ${embeddable.length} observation(s), ${cachedCount} already cached`);
    continue;
  }

  const t0 = Date.now();
  try {
    const vectors = await ensureEmbeddings(dir, signals, embedder);
    const embedded = vectors.size - Math.min(cachedCount, vectors.size);
    totalEmbedded += Math.max(0, embedded);
    totalCached += Math.min(cachedCount, vectors.size);
    console.log(
      `  ${id}: ${vectors.size} vector(s) (${Math.max(0, embedded)} new) in ${Date.now() - t0}ms`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`  ${id}: failed — ${message}`);
  }
}

console.log(
  dryRun
    ? `Dry run: ${totalSignals} embeddable observation(s) across ${sessionDirs.length} session(s).`
    : `Done: ${totalEmbedded} newly embedded, ${totalCached} reused, ${totalSignals} total.`,
);
