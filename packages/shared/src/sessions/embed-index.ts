/**
 * Session-level embedding index operations, shared by the embed worker and
 * the backfill script (both child processes), plus the read-only backlog scan
 * the app uses to decide what to hand to the worker.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Embedder } from './embedder.ts';
import { loadObservationSignals } from './observation-loader.ts';
import { ensureEmbeddings, lookupEmbeddings, type EmbedModelIdentity } from './vector-sidecar.ts';

/**
 * Bring one session's vector sidecar up to date with its ledger. Returns how
 * many texts had to be embedded (0 = already current). Throws on embed
 * failure — chunks embedded before the failure stay persisted.
 */
export async function indexSessionEmbeddings(sessionDir: string, embedder: Embedder): Promise<number> {
  const signals = loadObservationSignals(sessionDir);
  if (signals.length === 0) return 0;
  const { missing } = lookupEmbeddings(sessionDir, signals, embedder);
  // Run even when nothing is missing: ensureEmbeddings prunes vectors of
  // bullets a reflection removed.
  await ensureEmbeddings(sessionDir, signals, embedder);
  return missing;
}

/** Read-only: does this session have observations without a cached vector? */
export function sessionNeedsEmbeddings(sessionDir: string, identity: EmbedModelIdentity): boolean {
  try {
    const signals = loadObservationSignals(sessionDir);
    return signals.length > 0 && lookupEmbeddings(sessionDir, signals, identity).missing > 0;
  } catch {
    return false; // unreadable session: nothing the worker could do either
  }
}

/** Read-only scan of `<workspaceRoot>/sessions/*` for sessions with an embedding backlog. */
export function findSessionsNeedingEmbeddings(
  workspaceRootPaths: string[],
  identity: EmbedModelIdentity,
): string[] {
  const out: string[] = [];
  for (const root of workspaceRootPaths) {
    const sessionsDir = join(root, 'sessions');
    let names: string[];
    try {
      names = readdirSync(sessionsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = join(sessionsDir, name);
      if (sessionNeedsEmbeddings(dir, identity)) out.push(dir);
    }
  }
  return out;
}
