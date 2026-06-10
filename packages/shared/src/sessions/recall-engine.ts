/**
 * Recall engine — cross-session ("resource-scoped") retrieval over the
 * per-session observation ledgers. This is the B2 pivot: instead of merging
 * all observations into one physical workspace log (Mastra's `scope:'resource'`
 * via SQL), we keep the per-session Markdown+sidecar files untouched and build
 * a *lazy index* over them at query time. The durable pointer each hit carries
 * — `(sessionId, messageRange)` — resolves back to the raw `session.jsonl`,
 * which is the file-model equivalent of Mastra's `range = startId:endId`
 * pointer onto its SQL message store.
 *
 * Two responsibilities, kept separate so each is testable in isolation:
 *   1. `recall(...)`     — find relevant observations across all sessions
 *                          (anchor filter + text scoring; vector search later).
 *   2. `resolvePointer(...)` — page the raw messages behind a hit's pointer.
 *
 * The Observer/Reflector keep writing per-session as before; this engine only
 * reads. No new persistence, no migration. A materialised index can replace the
 * lazy scan later if measurements demand it — the API here stays the same.
 */

import { readdirSync } from 'node:fs';
import type { AnchorRef, AnchorType } from './anchors.ts';
import { anchorKey, ANCHOR_TYPES } from './anchors.ts';
import { loadObservationSignals } from './observation-loader.ts';
import { readAllMessages, type ObservableMessage } from './observation-watermark.ts';
import { getWorkspaceSessionsPath } from '../workspaces/storage.ts';
import { getSessionPath, getSessionFilePath } from './storage.ts';
import { cosineSimilarity, resolveEmbedder, type Embedder } from './embedder.ts';
import { ensureEmbeddings } from './vector-sidecar.ts';

// ============================================================================
// Types
// ============================================================================

export interface RecallQuery {
  /** Free-text query; scored by token overlap against summary + excerpt. */
  text?: string;
  /** Exact framework-anchor filter (precise, explainable axis). */
  anchor?: { type: AnchorType; id: string };
  /** Restrict to a single session (skip the cross-session scan). */
  sessionId?: string;
  /** Max hits to return (default 20). */
  limit?: number;
}

export interface RecallHit {
  sessionId: string;
  summary: string;
  excerpt: string;
  createdAt: string;
  salience?: string;
  anchorRefs: AnchorRef[];
  /** Durable pointer onto the raw session.jsonl. */
  messageRange: { from: string; to: string };
  /** Composite relevance score (higher = better). */
  score: number;
  /** Which signals contributed to the match (for explainability/UI). */
  matched: Array<'anchor' | 'text' | 'semantic' | 'recency'>;
}

export interface ResolvedPointer {
  sessionId: string;
  anchorMessageId: string;
  /** The anchor message plus a small surrounding window. */
  messages: ObservableMessage[];
  /** Index of the anchor message within `messages`. */
  anchorIndex: number;
}

// ============================================================================
// Index (lazy scan)
// ============================================================================

/** List session IDs in a workspace. Best-effort; missing dir → []. */
function listSessionIds(workspaceRootPath: string): string[] {
  const sessionsDir = getWorkspaceSessionsPath(workspaceRootPath);
  try {
    return readdirSync(sessionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Coerce the loosely-typed `unknown[]` anchorRefs into AnchorRef-ish records. */
function toAnchorRefs(raw: unknown): AnchorRef[] {
  if (!Array.isArray(raw)) return [];
  const out: AnchorRef[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === 'object') {
      const a = entry as Record<string, unknown>;
      if (typeof a.type === 'string' && typeof a.id === 'string') {
        out.push(a as unknown as AnchorRef);
      }
    }
  }
  return out;
}

// ============================================================================
// Scoring
// ============================================================================

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
}

/**
 * Fraction of distinct query tokens that appear in the haystack (summary +
 * excerpt). Deterministic and transparent — no embeddings yet. Returns 0..1.
 */
function textScore(queryTokens: string[], haystack: string): number {
  if (queryTokens.length === 0) return 0;
  const hay = new Set(tokenize(haystack));
  let hits = 0;
  for (const t of new Set(queryTokens)) if (hay.has(t)) hits++;
  return hits / new Set(queryTokens).size;
}

/** Newer observations get a small tiebreak (0..~0.1) so recency never
 *  outweighs an anchor or text match but breaks ties predictably. */
function recencyBoost(createdAt: string, now: number): number {
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return 0;
  const ageDays = Math.max(0, (now - t) / 86_400_000);
  return 0.1 / (1 + ageDays); // 0.1 today → ~0.05 at 1d → →0 as it ages
}

// ============================================================================
// Public: recall
// ============================================================================

/**
 * Cross-session recall. Scans per-session ledgers, filters by anchor (exact),
 * scores by text overlap, and returns the top hits with durable pointers.
 *
 * Scoring model (intentionally simple and explainable):
 *   - anchor match  → +1.0 base (precise structural axis)
 *   - text overlap  → +overlapFraction (0..1)
 *   - recency       → +small tiebreak (0..0.1)
 * A query with neither text nor anchor returns the most recent observations.
 */
export function recall(
  workspaceRootPath: string,
  query: RecallQuery,
  clock: () => number = () => Date.now(),
): RecallHit[] {
  const limit = query.limit ?? 20;
  const now = clock();
  const queryTokens = query.text ? tokenize(query.text) : [];
  const wantAnchorKey = query.anchor ? `${query.anchor.type}:${query.anchor.id}` : undefined;

  const sessionIds = query.sessionId ? [query.sessionId] : listSessionIds(workspaceRootPath);
  const hits: RecallHit[] = [];

  for (const sessionId of sessionIds) {
    const sessionDir = getSessionPath(workspaceRootPath, sessionId);
    let signals;
    try {
      signals = loadObservationSignals(sessionDir);
    } catch {
      continue; // one bad session never sinks the whole recall
    }

    for (const sig of signals) {
      const anchorRefs = toAnchorRefs(sig.anchorRefs);
      const matched: RecallHit['matched'] = [];
      let score = 0;

      if (wantAnchorKey) {
        const has = anchorRefs.some((a) => anchorKey(a) === wantAnchorKey);
        if (!has) continue; // anchor is a hard filter when present
        score += 1.0;
        matched.push('anchor');
      }

      if (queryTokens.length > 0) {
        const haystack = `${sig.summary}\n${sig.conversation?.excerpt ?? ''}`;
        const overlap = textScore(queryTokens, haystack);
        if (overlap === 0 && !wantAnchorKey) continue; // no text hit, no anchor → drop
        if (overlap > 0) {
          score += overlap;
          matched.push('text');
        }
      }

      const rb = recencyBoost(sig.createdAt, now);
      score += rb;
      if (matched.length === 0) matched.push('recency');

      hits.push({
        sessionId,
        summary: sig.summary,
        excerpt: sig.conversation?.excerpt ?? '',
        createdAt: sig.createdAt,
        salience: sig.salience,
        anchorRefs,
        messageRange: {
          from: sig.conversation?.messageRange?.from ?? '',
          to: sig.conversation?.messageRange?.to ?? sig.conversation?.messageRange?.from ?? '',
        },
        score,
        matched,
      });
    }
  }

  hits.sort((a, b) => b.score - a.score || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return hits.slice(0, limit);
}

// ============================================================================
// Public: recallSemantic (vector-scored variant)
// ============================================================================

export interface SemanticRecallOptions {
  /** Inject a provider (tests); defaults to `resolveEmbedder()`. */
  embedder?: Embedder | null;
  /** Optional cosine floor (0..1), like Mastra's `semanticRecall.threshold`.
   *  Default 0 = pure ranking, exactly Mastra's default behaviour. */
  minSimilarity?: number;
}

/**
 * Semantic recall — `recall()` with the text axis upgraded from token overlap
 * to embedding similarity. Everything else is identical by construction:
 * anchors stay a hard filter, the durable pointer is untouched, and the
 * scoring model keeps its shape:
 *
 *   anchor match → +1.0   |   meaning → +max(textOverlap, cosineSim)   |   recency tiebreak
 *
 * `max(text, sem)` rather than vector-only: exact word hits (IDs, file names,
 * error strings) are something embeddings are *worse* at than grep — the two
 * signals cover each other's blind spots.
 *
 * Degrades to plain `recall()` whenever semantics can't contribute: no query
 * text, embedder unavailable/disabled, or query embedding fails. Per-session
 * embedding failures degrade only that session to text scoring. Callers can
 * therefore use this unconditionally.
 */
export async function recallSemantic(
  workspaceRootPath: string,
  query: RecallQuery,
  opts: SemanticRecallOptions = {},
  clock: () => number = () => Date.now(),
): Promise<RecallHit[]> {
  if (!query.text) return recall(workspaceRootPath, query, clock);

  const embedder = opts.embedder !== undefined ? opts.embedder : await resolveEmbedder();
  if (!embedder) return recall(workspaceRootPath, query, clock);

  let queryVector: Float32Array | undefined;
  try {
    queryVector = (await embedder.embed([query.text], 'query'))[0];
  } catch {
    queryVector = undefined;
  }
  if (!queryVector) return recall(workspaceRootPath, query, clock);

  const limit = query.limit ?? 20;
  const minSimilarity = opts.minSimilarity ?? 0;
  const now = clock();
  const queryTokens = tokenize(query.text);
  const wantAnchorKey = query.anchor ? `${query.anchor.type}:${query.anchor.id}` : undefined;

  const sessionIds = query.sessionId ? [query.sessionId] : listSessionIds(workspaceRootPath);
  const hits: RecallHit[] = [];

  for (const sessionId of sessionIds) {
    const sessionDir = getSessionPath(workspaceRootPath, sessionId);
    let signals;
    try {
      signals = loadObservationSignals(sessionDir);
    } catch {
      continue; // one bad session never sinks the whole recall
    }

    let vectors: Map<string, Float32Array>;
    try {
      vectors = await ensureEmbeddings(sessionDir, signals, embedder);
    } catch {
      vectors = new Map(); // this session degrades to text scoring
    }

    for (const sig of signals) {
      const anchorRefs = toAnchorRefs(sig.anchorRefs);
      const matched: RecallHit['matched'] = [];
      let score = 0;

      if (wantAnchorKey) {
        const has = anchorRefs.some((a) => anchorKey(a) === wantAnchorKey);
        if (!has) continue; // anchor is a hard filter when present
        score += 1.0;
        matched.push('anchor');
      }

      const haystack = `${sig.summary}\n${sig.conversation?.excerpt ?? ''}`;
      const overlap = textScore(queryTokens, haystack);
      const vector = vectors.get(sig.id);
      const sim = vector ? Math.max(0, cosineSimilarity(queryVector, vector)) : 0;
      const meaning = Math.max(overlap, sim >= minSimilarity ? sim : 0);

      if (meaning === 0 && !wantAnchorKey) continue; // nothing relevant → drop
      if (meaning > 0) {
        score += meaning;
        matched.push(sim > overlap && sim >= minSimilarity ? 'semantic' : 'text');
      }

      const rb = recencyBoost(sig.createdAt, now);
      score += rb;
      if (matched.length === 0) matched.push('recency');

      hits.push({
        sessionId,
        summary: sig.summary,
        excerpt: sig.conversation?.excerpt ?? '',
        createdAt: sig.createdAt,
        salience: sig.salience,
        anchorRefs,
        messageRange: {
          from: sig.conversation?.messageRange?.from ?? '',
          to: sig.conversation?.messageRange?.to ?? sig.conversation?.messageRange?.from ?? '',
        },
        score,
        matched,
      });
    }
  }

  hits.sort((a, b) => b.score - a.score || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return hits.slice(0, limit);
}

// ============================================================================
// Public: recall hint (cross-session "you have prior work" pointer)
// ============================================================================

export interface RecallHintInput {
  workspaceRootPath: string;
  /** Current session — excluded so the hint is about OTHER sessions only. */
  sessionId: string;
  /** Current session's anchors (loosely typed; non-framework types ignored). */
  anchors: Array<{ type: string; id: string; title?: string }>;
  /** Hits scanned per anchor before aggregation. Default 50. */
  perAnchorLimit?: number;
}

export interface RecallHintData {
  /** Distinct matching observations across other sessions. */
  observationCount: number;
  /** Distinct other sessions that carry a match. */
  sessionCount: number;
  /** The source session IDs (newest-match first), for naming in the hint. */
  sessionIds: string[];
  /** The session anchors that actually have cross-session matches. */
  anchors: Array<{ type: AnchorType; id: string; title?: string }>;
}

/**
 * Detect whether OTHER sessions hold observations sharing an anchor with the
 * current session — the signal behind the `<relevant_memory>` recall pointer.
 *
 * Built ON TOP of `recall()` so the hint draws from the SAME source the
 * `recall` tool reads: when the hint fires, recall is guaranteed to return
 * something. (The retired episode-index detector could promise matches that
 * recall couldn't actually surface — two indexes, one truth claim.)
 * Self-suppressing: empty result → caller emits no block.
 */
export function gatherRecallHint(
  input: RecallHintInput,
  clock: () => number = () => Date.now(),
): RecallHintData {
  const sessions = new Set<string>();
  const matchedAnchors = new Map<string, { type: AnchorType; id: string; title?: string }>();
  const seenObs = new Set<string>();

  for (const anchor of input.anchors) {
    if (!ANCHOR_TYPES.includes(anchor.type as AnchorType)) continue;
    const type = anchor.type as AnchorType;
    const hits = recall(
      input.workspaceRootPath,
      { anchor: { type, id: anchor.id }, limit: input.perAnchorLimit ?? 50 },
      clock,
    );
    for (const h of hits) {
      if (h.sessionId === input.sessionId) continue; // other sessions only
      const obsKey = `${h.sessionId}:${h.messageRange.from || h.createdAt}`;
      if (!seenObs.has(obsKey)) {
        seenObs.add(obsKey);
        sessions.add(h.sessionId);
      }
      // Prefer a title from the input anchor, else snapshot from the matched
      // observation's anchorRef, else whatever we recorded earlier.
      const key = `${type}:${anchor.id}`;
      const ref = h.anchorRefs.find((a) => a.type === type && a.id === anchor.id);
      const title = anchor.title ?? ref?.title ?? matchedAnchors.get(key)?.title;
      matchedAnchors.set(key, { type, id: anchor.id, title });
    }
  }

  return {
    observationCount: seenObs.size,
    sessionCount: sessions.size,
    sessionIds: [...sessions],
    anchors: [...matchedAnchors.values()],
  };
}

/**
 * Render the slim `<relevant_memory>` pointer from gathered hint data. Returns
 * null when there is nothing to recall, so the caller can push unconditionally.
 *
 * Deliberately compact (it does NOT dump summaries — that was the per-turn push
 * bloat the B2 pivot removed) but DIRECTIVE: an informational "you may call
 * recall" pointer was empirically ignored by the agent mid-task even when
 * highly relevant prior work existed, so this phrases the pull as an explicit
 * step-zero instruction with a concrete recall invocation and named sources.
 */
export function renderRecallHintBlock(data: RecallHintData): string | null {
  if (data.observationCount === 0 || data.anchors.length === 0) return null;

  const anchorList = data.anchors
    .map((a) => `${a.title ?? a.id} (anchorType="${a.type}", anchorId="${a.id}")`)
    .join('; ');
  const obsWord = data.observationCount === 1 ? 'decision/observation' : 'decisions/observations';
  const sessWord = data.sessionCount === 1 ? 'earlier session' : 'earlier sessions';
  const sources = data.sessionIds.length > 0 ? ` (${data.sessionIds.join(', ')})` : '';
  // Lead with the first matched anchor as the most likely recall argument.
  const primary = data.anchors[0]!;

  return `<relevant_memory>
You are anchored to: ${anchorList}. ${data.observationCount} ${obsWord} about this already exist in ${data.sessionCount} ${sessWord}${sources}.

This is prior work you cannot see in your current context. Before you answer, decide, or start implementing anything tied to these anchors, your FIRST step is to call the \`recall\` tool to load it — do not re-derive or re-decide what was already settled. For example:
  recall({ anchorType: "${primary.type}", anchorId: "${primary.id}" })
or pass a \`text\` query for a specific question. Skip this only if the user's request is clearly unrelated to the anchors above.
</relevant_memory>`;
}

// ============================================================================
// Public: resolvePointer
// ============================================================================

/**
 * Page the raw messages behind a recall hit's pointer. Opens the hit's
 * `session.jsonl`, finds the anchor message by ID, and returns it with a small
 * surrounding window so the agent (or UI) sees the exact wording/chronology the
 * observation compressed away. Returns null if the session or message is gone.
 */
export function resolvePointer(
  workspaceRootPath: string,
  sessionId: string,
  messageId: string,
  opts: { before?: number; after?: number } = {},
): ResolvedPointer | null {
  const before = opts.before ?? 2;
  const after = opts.after ?? 6;
  const jsonlPath = getSessionFilePath(workspaceRootPath, sessionId);

  let messages: ObservableMessage[];
  try {
    messages = readAllMessages(jsonlPath);
  } catch {
    return null;
  }

  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx < 0) return null;

  const start = Math.max(0, idx - before);
  const window = messages.slice(start, idx + after + 1);
  return {
    sessionId,
    anchorMessageId: messageId,
    messages: window,
    anchorIndex: idx - start,
  };
}
