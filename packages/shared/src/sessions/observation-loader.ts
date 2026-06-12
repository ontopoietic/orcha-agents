/**
 * Observation loader — materialize bullets from `observations.md` +
 * `observations-evidence.json` into the canonical `ObservationSignal` shape
 * used by the UI, the reflector, and Orcha side-tools (recall-anchors,
 * artifact-extractor).
 *
 * Source-of-truth post Plan A/C: the canonical store is the Markdown ledger
 * plus its evidence sidecar. `observations.json` is supported as a last-resort
 * fallback for legacy sessions that haven't been migrated by
 * `scripts/orcha-migrate-observations.ts`.
 *
 * ID schemes:
 *   - `'anchor-stable'`: `obs-<shortId>[-<dup>]` — stable across re-reads so
 *     React keys don't churn. Default for UI callers.
 *   - `'bullet-index'`: `bullet-<idx>` — simple positional ID for LLM-side
 *     prompt handles (reflector talks about bullets by position).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseObservationsMarkdown, type ParsedBullet } from './observation-markdown-parser.ts';
import { parseMastraLedger, type MastraParsedBullet } from './mastra-om/parse-ledger.ts';
import type { ObservationSignal } from './observation-watermark.ts';

/**
 * Derive the session ID from a session directory path. The session folder name
 * IS the canonical session ID (see storage.ts — `sessionId = entry.name`), and
 * the JSONL header carries the same value under `header.id`. The evidence
 * sidecar deliberately omits sessionId because, per-session, it is redundant
 * with the file location. Cross-session retrieval (B2 index) needs the pointer
 * to carry `(sessionId, messageId)`, so we recover sessionId from the path here
 * instead of denormalising it into every sidecar entry.
 */
function sessionIdFromDir(sessionDir: string): string {
  return basename(sessionDir);
}

interface EvidenceEntry {
  fullMessageId: string;
  messageRangeTo?: string;
  excerpt?: string;
  actor?: 'user' | 'agent';
  createdAt?: string;
  anchorRefs?: unknown[];
}

export type ObservationIdStrategy = 'anchor-stable' | 'bullet-index';

/** Parse the epoch (ms) embedded in a message id `msg-<epochMs>-<short>`. */
export function epochFromMessageId(id: string | undefined | null): number | null {
  if (!id) return null;
  const m = /(?:^|-)(\d{12,})(?:-|$)/.exec(id);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Zero-pad a `H:MM` time to `HH:MM`; returns '' if unparseable. */
function normalizeTime(t: string | undefined): string {
  if (!t) return '';
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) return '';
  const h = Math.min(23, parseInt(m[1]!, 10));
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/**
 * Stable, deterministic createdAt for an observation bullet.
 *
 * CRUCIAL: this must NEVER return `new Date()`. A now-fallback makes the
 * timestamp change on every read, so old bullets perpetually re-stamp to the
 * present and float to the top of the newest-first UI — exactly the "same
 * observations, new timestamps, old content" symptom. Every branch here is
 * deterministic given the on-disk data.
 *
 * Priority (most → least accurate, all stable):
 *   1. The cited message's actual time — epoch embedded in the evidence
 *      `fullMessageId` (real conversation time, fixes "old content looks new").
 *   2. The observer run-time (`evidence.createdAt`).
 *   3. The bullet's ledger date + (zero-padded) time.
 *   4. The bullet's ledger date alone (midnight).
 *   5. Empty string — unknown time sorts deterministically to the bottom,
 *      never to the top.
 */
export function stableObservationCreatedAt(
  bullet: { date: string | null; time: string },
  evidence?: { fullMessageId?: string; createdAt?: string },
): string {
  const epoch = epochFromMessageId(evidence?.fullMessageId);
  if (epoch != null) return new Date(epoch).toISOString();
  if (evidence?.createdAt) return evidence.createdAt;
  if (bullet.date) {
    const hhmm = normalizeTime(bullet.time) || '00:00';
    const d = new Date(`${bullet.date}T${hhmm}:00`);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    const dateOnly = new Date(`${bullet.date}T00:00:00`);
    if (!Number.isNaN(dateOnly.getTime())) return dateOnly.toISOString();
  }
  return '';
}

function loadEvidenceSidecar(sessionDir: string): Record<string, EvidenceEntry> {
  const sidecarPath = join(sessionDir, 'data', 'observations-evidence.json');
  if (!existsSync(sidecarPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
    return raw && typeof raw === 'object' ? (raw as Record<string, EvidenceEntry>) : {};
  } catch {
    return {};
  }
}

/**
 * Read `observations.md` + evidence sidecar into ObservationSignal[].
 * Returns null when the MD file is missing or parses empty (caller can then
 * fall back to JSON via `loadObservationSignalsFromJson`).
 */
export function loadObservationSignalsFromMarkdown(
  sessionDir: string,
  idStrategy: ObservationIdStrategy = 'anchor-stable',
): ObservationSignal[] | null {
  const mdPath = join(sessionDir, 'data', 'observations.md');
  if (!existsSync(mdPath)) return null;
  let bullets: ParsedBullet[] | null;
  try {
    bullets = parseObservationsMarkdown(readFileSync(mdPath, 'utf-8'));
  } catch {
    return null;
  }
  if (!bullets || bullets.length === 0) return null;

  const sidecar = loadEvidenceSidecar(sessionDir);
  const sessionId = sessionIdFromDir(sessionDir);
  const result: ObservationSignal[] = [];
  // Stable IDs: per-anchor counter so duplicates get -1/-2 suffix and the
  // ID survives unchanged across re-reads of the same file.
  const seenAnchorCounts = new Map<string, number>();
  for (let i = 0; i < bullets.length; i++) {
    const bullet = bullets[i]!;
    const evidence = bullet.anchorShortId ? sidecar[bullet.anchorShortId] : undefined;
    const createdAt = stableObservationCreatedAt(bullet, evidence);

    let id: string;
    if (idStrategy === 'bullet-index') {
      id = `bullet-${i}`;
    } else {
      const anchor = bullet.anchorShortId ?? 'md';
      const dupIdx = seenAnchorCounts.get(anchor) ?? 0;
      seenAnchorCounts.set(anchor, dupIdx + 1);
      id = `obs-${anchor}${dupIdx > 0 ? `-${dupIdx}` : ''}`;
    }

    result.push({
      id,
      createdAt,
      source: 'conversation',
      summary: bullet.summary,
      status: 'raw',
      salience: bullet.salience,
      anchorRefs: evidence?.anchorRefs as ObservationSignal['anchorRefs'],
      conversation: {
        sessionId,
        messageRange: {
          from: evidence?.fullMessageId ?? '',
          to: evidence?.messageRangeTo ?? evidence?.fullMessageId ?? '',
        },
        excerpt: evidence?.excerpt ?? '',
        actor: evidence?.actor ?? 'agent',
      },
    });
  }
  return result;
}

/**
 * Last-resort JSON fallback. Read `observations.json` as plain ObservationSignal[]
 * for legacy sessions that haven't been migrated.
 */
export function loadObservationSignalsFromJson(sessionDir: string): ObservationSignal[] {
  const jsonPath = join(sessionDir, 'data', 'observations.json');
  if (!existsSync(jsonPath)) return [];
  try {
    const raw = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    const arr = Array.isArray(raw) ? raw : raw.signals;
    return Array.isArray(arr) ? (arr as ObservationSignal[]) : [];
  } catch {
    return [];
  }
}

/**
 * Read `observations.mastra.md` into ObservationSignal[]. Returns null when
 * the file is missing or parses empty.
 *
 * Anchors: post Phase 1, Mastra bullets carry `{shortId}` anchors (emitted
 * under the ORCHA_ANCHOR_INSTRUCTION override). We resolve those against
 * `observations-evidence.mastra.json` to populate messageRange/excerpt/actor
 * so the UI back-link works the same as for the legacy ledger.
 */
function loadMastraEvidenceSidecar(sessionDir: string): Record<string, EvidenceEntry> {
  const sidecarPath = join(sessionDir, 'data', 'observations-evidence.mastra.json');
  if (!existsSync(sidecarPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
    return raw && typeof raw === 'object' ? (raw as Record<string, EvidenceEntry>) : {};
  } catch {
    return {};
  }
}

export function loadObservationSignalsFromMastraMarkdown(
  sessionDir: string,
  idStrategy: ObservationIdStrategy = 'anchor-stable',
): ObservationSignal[] | null {
  const mdPath = join(sessionDir, 'data', 'observations.mastra.md');
  if (!existsSync(mdPath)) return null;
  let bullets: MastraParsedBullet[] | null;
  try {
    bullets = parseMastraLedger(readFileSync(mdPath, 'utf-8'));
  } catch {
    return null;
  }
  if (!bullets || bullets.length === 0) return null;

  const sidecar = loadMastraEvidenceSidecar(sessionDir);
  const sessionId = sessionIdFromDir(sessionDir);
  const result: ObservationSignal[] = [];
  const seenAnchorCounts = new Map<string, number>();

  for (let i = 0; i < bullets.length; i++) {
    const bullet = bullets[i]!;
    const evidence = bullet.anchorShortId ? sidecar[bullet.anchorShortId] : undefined;
    const createdAt = stableObservationCreatedAt(bullet, evidence);

    let id: string;
    if (idStrategy === 'bullet-index') {
      id = `bullet-${i}`;
    } else if (bullet.anchorShortId) {
      const anchor = bullet.anchorShortId;
      const dupIdx = seenAnchorCounts.get(anchor) ?? 0;
      seenAnchorCounts.set(anchor, dupIdx + 1);
      id = `obs-${anchor}${dupIdx > 0 ? `-${dupIdx}` : ''}`;
    } else {
      id = `obs-mastra-${i}`;
    }

    result.push({
      id,
      createdAt,
      source: 'conversation',
      summary: bullet.summary,
      status: 'raw',
      salience: bullet.salience,
      anchorRefs: evidence?.anchorRefs as ObservationSignal['anchorRefs'],
      conversation: {
        sessionId,
        messageRange: {
          from: evidence?.fullMessageId ?? '',
          to: evidence?.messageRangeTo ?? evidence?.fullMessageId ?? '',
        },
        excerpt: evidence?.excerpt ?? '',
        actor: evidence?.actor ?? 'agent',
      },
    });
  }
  return result;
}

/**
 * Combined accessor.
 *
 * Strategy (post Phase 4 of the Mastra migration): MERGE both ledgers when
 * both are present so legacy content stays visible without forcing a
 * destructive migration script. Mastra wins on ID collision (same anchor
 * observed by both paths). Falls back to JSON only when neither MD exists.
 *
 * Result is sorted ascending by createdAt so the UI's chronological grouping
 * Just Works regardless of which path produced which bullet.
 */
export function loadObservationSignals(
  sessionDir: string,
  idStrategy: ObservationIdStrategy = 'anchor-stable',
): ObservationSignal[] {
  const fromMastra = loadObservationSignalsFromMastraMarkdown(sessionDir, idStrategy) ?? [];
  const fromLegacyMd = loadObservationSignalsFromMarkdown(sessionDir, idStrategy) ?? [];
  if (fromMastra.length === 0 && fromLegacyMd.length === 0) {
    return loadObservationSignalsFromJson(sessionDir);
  }
  return mergeObservationSignals(fromMastra, fromLegacyMd);
}

/**
 * Merge two ObservationSignal lists. Order is: Mastra entries first (they
 * "win" on duplicate IDs), then legacy entries that don't collide. Finally
 * sort by createdAt ascending so chronological grouping in the UI is stable.
 */
export function mergeObservationSignals(
  preferred: ObservationSignal[],
  fallback: ObservationSignal[],
): ObservationSignal[] {
  const seen = new Set<string>();
  const out: ObservationSignal[] = [];
  for (const sig of preferred) {
    if (seen.has(sig.id)) continue;
    seen.add(sig.id);
    out.push(sig);
  }
  for (const sig of fallback) {
    if (seen.has(sig.id)) continue;
    seen.add(sig.id);
    out.push(sig);
  }
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return out;
}

/**
 * Read observations across EVERY session of a workspace — the human-facing
 * cross-session view (the replacement for the removed episode digest).
 *
 * Per-session dedup/merge is handled by `loadObservationSignals`; across
 * sessions there is deliberately NO dedup — signal IDs are only unique
 * within one session (`obs-<shortId>`), so consumers must key on
 * `(conversation.sessionId, id)`. Unreadable session dirs are skipped:
 * one corrupt session must not blank the whole workspace view.
 */
export function loadWorkspaceObservationSignals(workspaceRootPath: string): ObservationSignal[] {
  const sessionsDir = join(workspaceRootPath, 'sessions');
  if (!existsSync(sessionsDir)) return [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const all: ObservationSignal[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      all.push(...loadObservationSignals(join(sessionsDir, entry.name)));
    } catch {
      // Skip unreadable sessions — best-effort view.
    }
  }
  all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return all;
}
