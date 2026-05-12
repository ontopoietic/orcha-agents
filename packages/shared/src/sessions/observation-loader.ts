/**
 * Observation loader — materialize bullets from `observations.md` +
 * `observations-evidence.json` into the canonical `ObservationSignal` shape
 * used by the UI, the reflector, and Orcha side-tools (episode-emit,
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

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseObservationsMarkdown, type ParsedBullet } from './observation-markdown-parser.ts';
import type { ObservationSignal } from './observation-watermark.ts';

interface EvidenceEntry {
  fullMessageId: string;
  messageRangeTo?: string;
  excerpt?: string;
  actor?: 'user' | 'agent';
  createdAt?: string;
  anchorRefs?: unknown[];
}

export type ObservationIdStrategy = 'anchor-stable' | 'bullet-index';

/** Compose an ISO timestamp from a bullet's date + time, else "now". */
function deriveCreatedAt(bullet: ParsedBullet): string {
  if (bullet.date && bullet.time) {
    const iso = `${bullet.date}T${bullet.time}:00`;
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
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
  const result: ObservationSignal[] = [];
  // Stable IDs: per-anchor counter so duplicates get -1/-2 suffix and the
  // ID survives unchanged across re-reads of the same file.
  const seenAnchorCounts = new Map<string, number>();
  for (let i = 0; i < bullets.length; i++) {
    const bullet = bullets[i]!;
    const evidence = bullet.anchorShortId ? sidecar[bullet.anchorShortId] : undefined;
    const createdAt = evidence?.createdAt ?? deriveCreatedAt(bullet);

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
        sessionId: '',
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
 * Combined accessor: MD if available, else legacy JSON. Empty array on both
 * missing/malformed.
 */
export function loadObservationSignals(
  sessionDir: string,
  idStrategy: ObservationIdStrategy = 'anchor-stable',
): ObservationSignal[] {
  const fromMd = loadObservationSignalsFromMarkdown(sessionDir, idStrategy);
  if (fromMd && fromMd.length > 0) return fromMd;
  return loadObservationSignalsFromJson(sessionDir);
}
