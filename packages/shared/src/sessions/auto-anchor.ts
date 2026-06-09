/**
 * Auto-anchor pass — propose framework-anchors (feature/befund/anliegen) for
 * observations that were never manually anchored, so the precise anchor axis of
 * cross-session recall works without hand-tagging (handoff §6.2).
 *
 * This module is the PURE core: prompt construction, response parsing, and the
 * sidecar merge. The actual LLM call (a haiku pass) and the candidate-artifact
 * source live in the detached CLI (scripts/orcha-recall-anchors.ts), so this
 * file stays free of I/O and trivially testable with a mocked extractor.
 *
 * Closed vocabulary by design: the pass may only assign anchor IDs that already
 * exist in Orcha (passed in as candidates). Free-text labels would not match the
 * UUID-keyed anchorRefs the recall engine filters on, so they would help only
 * the (already-present) text axis, not the precise anchor axis.
 */

import type { AnchorRef, AnchorType } from './anchors.ts';
import { anchorKey } from './anchors.ts';

// ============================================================================
// Types
// ============================================================================

/** An existing Orcha framework artifact the pass may assign. */
export interface AnchorCandidate {
  type: AnchorType;
  id: string;
  title: string;
}

/** An observation to be considered for tagging. */
export interface ObservationForTagging {
  shortId: string;
  summary: string;
  excerpt?: string;
}

/** The LLM's proposed mapping for one observation. */
export interface AnchorAssignment {
  shortId: string;
  anchorIds: string[];
}

/** A minimal view of one evidence-sidecar entry (what we read/write). */
export interface SidecarEntry {
  fullMessageId?: string;
  messageRangeTo?: string;
  excerpt?: string;
  actor?: string;
  createdAt?: string;
  anchorRefs?: AnchorRef[];
  [k: string]: unknown;
}

// ============================================================================
// Prompt
// ============================================================================

export function buildAutoAnchorPrompt(
  observations: ObservationForTagging[],
  candidates: AnchorCandidate[],
): { system: string; user: string } {
  const system = [
    'You assign Orcha framework-anchors to conversation observations.',
    'Anchors describe WHICH project artifact an observation is about.',
    '',
    'Hard rules:',
    '- You may ONLY use anchor IDs from the provided candidate list. Never invent IDs.',
    '- Assign an anchor only when the observation is clearly ABOUT that artifact.',
    '- An observation may map to zero, one, or several candidates. Prefer precision: if unsure, assign none.',
    '- Output STRICT JSON only: an array of {"shortId": string, "anchorIds": string[]}.',
    '- Omit observations you would not tag (do not emit empty anchorIds). No prose, no code fences.',
  ].join('\n');

  const candidateLines = candidates
    .map((c) => `- [${c.type}] ${c.id} :: ${c.title}`)
    .join('\n');

  const obsLines = observations
    .map((o) => {
      const ex = o.excerpt ? `\n    excerpt: ${o.excerpt.slice(0, 240)}` : '';
      return `- ${o.shortId}: ${o.summary}${ex}`;
    })
    .join('\n');

  const user = [
    'CANDIDATE ANCHORS (type, id, title):',
    candidateLines || '(none)',
    '',
    'OBSERVATIONS (shortId: summary):',
    obsLines || '(none)',
    '',
    'Return the JSON array of assignments.',
  ].join('\n');

  return { system, user };
}

// ============================================================================
// Response parsing
// ============================================================================

/**
 * Parse the LLM response into assignments. Tolerant: extracts the first JSON
 * array in the text, drops malformed entries, and keeps only non-empty
 * anchorId lists. Returns [] on any structural failure.
 */
export function parseAutoAnchorResponse(raw: string | null): AnchorAssignment[] {
  if (!raw) return [];
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: AnchorAssignment[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const shortId = e.shortId;
    const anchorIds = e.anchorIds;
    if (typeof shortId !== 'string' || !shortId) continue;
    if (!Array.isArray(anchorIds)) continue;
    const ids = anchorIds.filter((x): x is string => typeof x === 'string' && x.length > 0);
    if (ids.length === 0) continue;
    out.push({ shortId, anchorIds: ids });
  }
  return out;
}

// ============================================================================
// Sidecar merge
// ============================================================================

export interface MergeResult {
  sidecar: Record<string, SidecarEntry>;
  /** Number of (entry, anchor) pairs newly added. */
  added: number;
  /** shortIds that were assigned but not present in this sidecar. */
  skippedMissing: string[];
}

/**
 * Merge assignments into a sidecar dict (in place on a shallow copy). Only keys
 * that already exist in the sidecar are touched. Anchors are appended to each
 * entry's anchorRefs, deduped by type:id, so re-running is idempotent and never
 * clobbers manually-attached anchors. Unknown anchor IDs (not in candidates) are
 * ignored.
 */
export function mergeAssignmentsIntoSidecar(
  sidecar: Record<string, SidecarEntry>,
  assignments: AnchorAssignment[],
  candidates: AnchorCandidate[],
  now: string,
): MergeResult {
  const byId = new Map<string, AnchorCandidate>();
  for (const c of candidates) byId.set(c.id, c);

  const next: Record<string, SidecarEntry> = { ...sidecar };
  let added = 0;
  const skippedMissing: string[] = [];

  for (const a of assignments) {
    const entry = next[a.shortId];
    if (!entry) {
      skippedMissing.push(a.shortId);
      continue;
    }
    const existing = Array.isArray(entry.anchorRefs) ? [...entry.anchorRefs] : [];
    const seen = new Set(existing.map((r) => anchorKey(r)));

    for (const id of a.anchorIds) {
      const cand = byId.get(id);
      if (!cand) continue; // closed vocabulary: ignore unknown IDs
      const ref: AnchorRef = {
        type: cand.type,
        id: cand.id,
        title: cand.title,
        addedAt: now,
        addedBy: 'agent',
      };
      const key = anchorKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      existing.push(ref);
      added++;
    }

    next[a.shortId] = { ...entry, anchorRefs: existing };
  }

  return { sidecar: next, added, skippedMissing };
}
