#!/usr/bin/env npx tsx
/**
 * Orcha Auto-Anchor — propose framework-anchors for a session's observations so
 * the precise anchor axis of cross-session recall works without hand-tagging
 * (B2 pivot, step 3 / handoff §6.2).
 *
 * Pure logic (prompt / parse / merge) lives in
 * packages/shared/src/sessions/auto-anchor.ts; this CLI wires it to the shared
 * LLM helper and the on-disk sidecars. It writes anchorRefs back into the same
 * observations-evidence*.json files the recall engine already reads, so the
 * index improves with no new format and no migration.
 *
 * Candidate vocabulary (closed — the pass may only assign existing anchors):
 *   --candidates <path>  explicit JSON array of {type,id,title}
 *   (default)            harvested from anchors already present in ANY sidecar
 *                        across the workspace — zero dependency on the Orcha CLI.
 *
 * CLI:
 *   orcha-recall-anchors <sessionDir> [--candidates <path>] [--dry-run]
 *
 * Exit codes:
 *   0  ok (anchors written, or nothing to do)
 *   1  bad args / missing session
 *   2  no LLM auth available
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { loadObservationSignals } from '../packages/shared/src/sessions/observation-loader.ts';
import {
  buildAutoAnchorPrompt,
  parseAutoAnchorResponse,
  mergeAssignmentsIntoSidecar,
  type AnchorCandidate,
  type ObservationForTagging,
  type SidecarEntry,
} from '../packages/shared/src/sessions/auto-anchor.ts';
import { resolveExtractor, callExtractor } from './lib/llm-extractor.ts';

function usage(): never {
  console.error('Usage: orcha-recall-anchors <sessionDir> [--candidates <path>] [--dry-run]');
  process.exit(1);
}

const sessionDir = process.argv[2];
if (!sessionDir || sessionDir.startsWith('--')) usage();
if (!existsSync(sessionDir)) {
  console.error(`Session dir not found: ${sessionDir}`);
  process.exit(1);
}
const candidatesArgIdx = process.argv.indexOf('--candidates');
const candidatesPath = candidatesArgIdx >= 0 ? process.argv[candidatesArgIdx + 1] : undefined;
const dryRun = process.argv.includes('--dry-run');

const SIDECAR_FILES = ['observations-evidence.json', 'observations-evidence.mastra.json'];

function readSidecar(path: string): Record<string, SidecarEntry> {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    return raw && typeof raw === 'object' ? (raw as Record<string, SidecarEntry>) : {};
  } catch {
    return {};
  }
}

/** Harvest distinct existing anchors across all workspace sidecars. */
function harvestCandidates(workspaceSessionsDir: string): AnchorCandidate[] {
  const byKey = new Map<string, AnchorCandidate>();
  let sessionDirs: string[];
  try {
    sessionDirs = readdirSync(workspaceSessionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(workspaceSessionsDir, e.name, 'data'));
  } catch {
    return [];
  }
  for (const dataDir of sessionDirs) {
    for (const f of SIDECAR_FILES) {
      const sidecar = readSidecar(join(dataDir, f));
      for (const entry of Object.values(sidecar)) {
        for (const ref of entry.anchorRefs ?? []) {
          if (!ref || typeof ref.type !== 'string' || typeof ref.id !== 'string') continue;
          const key = `${ref.type}:${ref.id}`;
          if (!byKey.has(key)) {
            byKey.set(key, { type: ref.type, id: ref.id, title: ref.title ?? ref.id });
          }
        }
      }
    }
  }
  return [...byKey.values()];
}

// --- candidates -------------------------------------------------------------
let candidates: AnchorCandidate[];
if (candidatesPath) {
  if (!existsSync(candidatesPath)) {
    console.error(`Candidates file not found: ${candidatesPath}`);
    process.exit(1);
  }
  candidates = JSON.parse(readFileSync(candidatesPath, 'utf-8')) as AnchorCandidate[];
} else {
  const workspaceSessionsDir = dirname(sessionDir); // <root>/sessions/<id> → <root>/sessions
  candidates = harvestCandidates(workspaceSessionsDir);
}

if (candidates.length === 0) {
  console.log('AutoAnchor: no candidate anchors available (none harvested, none provided) — nothing to do.');
  process.exit(0);
}

// --- observations to tag ----------------------------------------------------
// Only observations that carry a sidecar shortId can be tagged (the shortId is
// the write key). loadObservationSignals gives id = `obs-<shortId>` for those.
const signals = loadObservationSignals(sessionDir);
const observations: ObservationForTagging[] = [];
for (const sig of signals) {
  const m = /^obs-([a-z0-9]+)(?:-\d+)?$/.exec(sig.id);
  if (!m) continue;
  observations.push({
    shortId: m[1]!,
    summary: sig.summary,
    excerpt: sig.conversation?.excerpt,
  });
}

if (observations.length === 0) {
  console.log('AutoAnchor: no anchorable observations (no sidecar-backed bullets) — nothing to do.');
  process.exit(0);
}

// --- LLM pass ---------------------------------------------------------------
const extractor = resolveExtractor({
  defaultModel: 'claude-haiku-4-5',
  modelEnvKeys: ['ORCHA_AUTOANCHOR_MODEL', 'ORCHA_OBSERVER_MODEL'],
  apiKeyEnvKeys: ['ORCHA_AUTOANCHOR_API_KEY', 'ORCHA_OBSERVER_API_KEY'],
});
if (!extractor) {
  console.warn('AutoAnchor: no LLM auth available (no OAuth token, no API key). Aborting.');
  process.exit(2);
}

const { system, user } = buildAutoAnchorPrompt(observations, candidates);

const run = async () => {
  const raw = await callExtractor(extractor, system, user, { logPrefix: 'AutoAnchor', timeoutMs: 60_000 });
  const assignments = parseAutoAnchorResponse(raw);
  console.log(
    `AutoAnchor: ${observations.length} observations, ${candidates.length} candidates → ${assignments.length} assignment(s).`,
  );
  if (assignments.length === 0) {
    process.exit(0);
  }

  const now = new Date().toISOString();
  let totalAdded = 0;
  for (const f of SIDECAR_FILES) {
    const path = join(sessionDir, 'data', f);
    if (!existsSync(path)) continue;
    const sidecar = readSidecar(path);
    const { sidecar: merged, added } = mergeAssignmentsIntoSidecar(sidecar, assignments, candidates, now);
    if (added > 0) {
      totalAdded += added;
      if (!dryRun) writeFileSync(path, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
      console.log(`  ${dryRun ? '[dry-run] would add' : 'added'} ${added} anchorRef(s) → ${basename(path)}`);
    }
  }
  console.log(`AutoAnchor: ${dryRun ? 'would add' : 'added'} ${totalAdded} anchorRef(s) total to session ${basename(sessionDir)}.`);
  process.exit(0);
};

run();
