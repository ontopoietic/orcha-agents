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
 *                          (text scoring; semantic scoring via embeddings).
 *   2. `resolvePointer(...)` — page the raw messages behind a hit's pointer.
 *
 * The Observer/Reflector keep writing per-session as before; this engine only
 * reads. No new persistence, no migration. A materialised index can replace the
 * lazy scan later if measurements demand it — the API here stays the same.
 */

import { readdirSync } from 'node:fs';
import { loadObservationSignals } from './observation-loader.ts';
import { readAllMessages, type ObservableMessage } from './observation-watermark.ts';
import { getWorkspaceSessionsPath } from '../workspaces/storage.ts';
import { getSessionPath, getSessionFilePath } from './storage.ts';
import { cosineSimilarity, type Embedder } from './embedder.ts';
import { getEmbedClient } from './embed-client.ts';
import { lookupEmbeddings } from './vector-sidecar.ts';

// ============================================================================
// Types
// ============================================================================

export interface RecallQuery {
  /** Free-text query; scored by token overlap against summary + excerpt. */
  text?: string;
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
  /** Durable pointer onto the raw session.jsonl. */
  messageRange: { from: string; to: string };
  /** Composite relevance score (higher = better). */
  score: number;
  /** Which signals contributed to the match (for explainability/UI). */
  matched: Array<'text' | 'semantic' | 'recency'>;
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
 *  outweighs a text match but breaks ties predictably. */
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
 * Cross-session recall. Scans per-session ledgers, scores by text overlap,
 * and returns the top hits with durable pointers.
 *
 * Scoring model (intentionally simple and explainable):
 *   - text overlap  → +overlapFraction (0..1)
 *   - recency       → +small tiebreak (0..0.1)
 * A query without text returns the most recent observations.
 */
export function recall(
  workspaceRootPath: string,
  query: RecallQuery,
  clock: () => number = () => Date.now(),
): RecallHit[] {
  const limit = query.limit ?? 20;
  const now = clock();
  const queryTokens = query.text ? tokenize(query.text) : [];

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
      const matched: RecallHit['matched'] = [];
      let score = 0;

      if (queryTokens.length > 0) {
        const haystack = `${sig.summary}\n${sig.conversation?.excerpt ?? ''}`;
        const overlap = textScore(queryTokens, haystack);
        if (overlap === 0) continue; // no text hit → drop
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
  /** Inject a provider (tests); defaults to the embed-worker client. */
  embedder?: Embedder | null;
  /** Optional cosine floor (0..1), like Mastra's `semanticRecall.threshold`.
   *  Default 0 = pure ranking, exactly Mastra's default behaviour. */
  minSimilarity?: number;
}

/** How much of the scanned memory could be scored semantically. */
export interface SemanticRecallCoverage {
  /** Observations scanned (after the session filter). */
  observations: number;
  /** Of those, how many had a cached vector (the rest scored by text only). */
  vectorized: number;
  /** Sessions whose missing vectors were handed to the worker for indexing. */
  indexingRequested: number;
}

export interface SemanticRecallResult {
  hits: RecallHit[];
  /** Absent when semantics could not contribute at all (pure text fallback). */
  coverage?: SemanticRecallCoverage;
}

/**
 * Semantic recall — `recall()` with the text axis upgraded from token overlap
 * to embedding similarity. Everything else is identical by construction:
 * the durable pointer is untouched, and the scoring model keeps its shape:
 *
 *   meaning → +max(textOverlap, cosineSim)   |   recency tiebreak
 *
 * `max(text, sem)` rather than vector-only: exact word hits (IDs, file names,
 * error strings) are something embeddings are *worse* at than grep — the two
 * signals cover each other's blind spots.
 *
 * READ-ONLY on the vector side: the only inference per call is the query
 * embedding. Observations without a cached vector are scored by text overlap
 * and their sessions are handed to the embed worker (`requestIndex`) so the
 * next call can use them. A workspace-wide scan therefore costs one query
 * embedding plus JSON reads, independent of the indexing backlog — before
 * 2026-09-30 it embedded the whole backlog inline and crashed the app.
 *
 * Degrades to plain `recall()` whenever semantics can't contribute: no query
 * text, embedder unavailable, or query embedding fails.
 */
export async function recallSemanticDetailed(
  workspaceRootPath: string,
  query: RecallQuery,
  opts: SemanticRecallOptions = {},
  clock: () => number = () => Date.now(),
): Promise<SemanticRecallResult> {
  const fallback = (): SemanticRecallResult => ({ hits: recall(workspaceRootPath, query, clock) });
  if (!query.text) return fallback();

  const embedder = opts.embedder !== undefined ? opts.embedder : getEmbedClient();
  if (!embedder) return fallback();

  let queryVector: Float32Array | undefined;
  try {
    queryVector = (await embedder.embed([query.text], 'query'))[0];
  } catch {
    queryVector = undefined;
  }
  if (!queryVector) return fallback();

  const limit = query.limit ?? 20;
  const minSimilarity = opts.minSimilarity ?? 0;
  const now = clock();
  const queryTokens = tokenize(query.text);

  const sessionIds = query.sessionId ? [query.sessionId] : listSessionIds(workspaceRootPath);
  const hits: RecallHit[] = [];
  const needsIndex: string[] = [];
  let observations = 0;
  let vectorized = 0;

  for (const sessionId of sessionIds) {
    const sessionDir = getSessionPath(workspaceRootPath, sessionId);
    let signals;
    try {
      signals = loadObservationSignals(sessionDir);
    } catch {
      continue; // one bad session never sinks the whole recall
    }

    const { vectors, missing } = lookupEmbeddings(sessionDir, signals, embedder);
    observations += signals.length;
    vectorized += vectors.size;
    if (missing > 0) needsIndex.push(sessionDir);

    for (const sig of signals) {
      const matched: RecallHit['matched'] = [];
      let score = 0;

      const haystack = `${sig.summary}\n${sig.conversation?.excerpt ?? ''}`;
      const overlap = textScore(queryTokens, haystack);
      const vector = vectors.get(sig.id);
      const sim = vector ? Math.max(0, cosineSimilarity(queryVector, vector)) : 0;
      const meaning = Math.max(overlap, sim >= minSimilarity ? sim : 0);

      if (meaning === 0) continue; // nothing relevant → drop
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
        messageRange: {
          from: sig.conversation?.messageRange?.from ?? '',
          to: sig.conversation?.messageRange?.to ?? sig.conversation?.messageRange?.from ?? '',
        },
        score,
        matched,
      });
    }
  }

  if (needsIndex.length > 0) {
    try {
      embedder.requestIndex?.(needsIndex);
    } catch {
      // indexing is best-effort — the answer below is already complete
    }
  }

  hits.sort((a, b) => b.score - a.score || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return {
    hits: hits.slice(0, limit),
    coverage: { observations, vectorized, indexingRequested: embedder.requestIndex ? needsIndex.length : 0 },
  };
}

/** `recallSemanticDetailed` without the coverage report. */
export async function recallSemantic(
  workspaceRootPath: string,
  query: RecallQuery,
  opts: SemanticRecallOptions = {},
  clock: () => number = () => Date.now(),
): Promise<RecallHit[]> {
  return (await recallSemanticDetailed(workspaceRootPath, query, opts, clock)).hits;
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
