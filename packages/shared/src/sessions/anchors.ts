/**
 * Session Anchors — references to Orcha framework artifacts
 *
 * Sessions can be anchored to Orcha-side artifacts (Feature, Befund, Anliegen)
 * to express what the session is conceptually working on. The anchor is
 * a scope key for grouping sessions in the UI and for later observational
 * memory aggregation.
 *
 * Anchors are additive: a session may have zero or many. Anchors carry a
 * snapshot of the artifact title at attach time so the UI can render without
 * a roundtrip. The `id` is the canonical reference; the snapshot may drift.
 */

export type AnchorType = 'feature' | 'befund' | 'anliegen';

export const ANCHOR_TYPES: readonly AnchorType[] = ['feature', 'befund', 'anliegen'] as const;

export interface AnchorRef {
  /** Orcha artifact category */
  type: AnchorType;
  /** Orcha artifact ID — canonical reference, scope key for grouping */
  id: string;
  /** Snapshot of artifact title at attach time (best-effort, may drift) */
  title?: string;
  /** ISO timestamp when the anchor was attached */
  addedAt: string;
  /** Who attached this anchor */
  addedBy: 'user' | 'agent';
}

/**
 * Stable key for an anchor reference (type:id), suitable for grouping
 * and Map keys. Two anchors with the same key refer to the same artifact
 * regardless of snapshot title or attach metadata.
 */
export function anchorKey(anchor: AnchorRef): string {
  return `${anchor.type}:${anchor.id}`;
}

/**
 * Compare two anchors for canonical equality (same type+id).
 * Snapshot title and attach metadata are ignored.
 */
export function anchorsEqual(a: AnchorRef, b: AnchorRef): boolean {
  return a.type === b.type && a.id === b.id;
}

/**
 * Validate an AnchorRef shape. Throws on invalid input.
 * Used at trust boundaries (IPC, persistence load, CLI input).
 */
export function validateAnchor(value: unknown): AnchorRef {
  if (!value || typeof value !== 'object') {
    throw new Error('AnchorRef: expected object');
  }
  const a = value as Record<string, unknown>;
  if (typeof a.type !== 'string' || !ANCHOR_TYPES.includes(a.type as AnchorType)) {
    throw new Error(`AnchorRef: invalid type "${String(a.type)}" (expected one of ${ANCHOR_TYPES.join(', ')})`);
  }
  if (typeof a.id !== 'string' || a.id.length === 0) {
    throw new Error('AnchorRef: id must be a non-empty string');
  }
  if (a.title !== undefined && typeof a.title !== 'string') {
    throw new Error('AnchorRef: title must be a string when present');
  }
  if (typeof a.addedAt !== 'string' || a.addedAt.length === 0) {
    throw new Error('AnchorRef: addedAt must be a non-empty ISO timestamp string');
  }
  if (a.addedBy !== 'user' && a.addedBy !== 'agent') {
    throw new Error(`AnchorRef: addedBy must be "user" or "agent" (got ${String(a.addedBy)})`);
  }
  return {
    type: a.type as AnchorType,
    id: a.id,
    title: a.title as string | undefined,
    addedAt: a.addedAt,
    addedBy: a.addedBy,
  };
}

/**
 * Lightweight projection of an Orcha artifact for the anchor picker UI.
 * Shaped from CLI output by `orcha-bridge`. Keep it small — the picker only
 * needs enough to render and to construct a fresh AnchorRef on selection.
 */
export interface AnchorableItem {
  type: AnchorType;
  id: string;
  title: string;
  /** Optional secondary line (status, parent name, category, ...) */
  subtitle?: string;
}

/**
 * Convert an AnchorableItem into a fresh AnchorRef ready to attach to a session.
 * Stamps `addedAt` from a clock function (defaults to Date.now) and caller-provided
 * `addedBy`. The title becomes the snapshot.
 */
export function anchorFromItem(
  item: AnchorableItem,
  addedBy: AnchorRef['addedBy'],
  now: () => string = () => new Date().toISOString(),
): AnchorRef {
  return {
    type: item.type,
    id: item.id,
    title: item.title,
    addedAt: now(),
    addedBy,
  };
}

/**
 * Validate an array of AnchorRefs, dropping invalid entries with a console
 * warning rather than throwing. Used when loading persisted data where we
 * prefer best-effort recovery over hard failure.
 */
export function validateAnchorsLenient(value: unknown): AnchorRef[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [];
  const result: AnchorRef[] = [];
  for (const entry of value) {
    try {
      result.push(validateAnchor(entry));
    } catch (err) {
      // Best-effort: drop invalid anchors silently in production paths.
      // Callers that need strictness should use validateAnchor directly.
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[anchors] dropping invalid AnchorRef:', err instanceof Error ? err.message : err);
      }
    }
  }
  return result;
}
