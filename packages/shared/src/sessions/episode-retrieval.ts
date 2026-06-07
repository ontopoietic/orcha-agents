/**
 * Episode Retrieval — surface past relevant episodes into the current
 * session's prompt context.
 *
 * Phase A.2 of memory-architecture-redesign. The handoff-killer: when a
 * new session opens (or a new phase starts after an anchor-change), this
 * module finds episodes from prior phases / prior sessions that share an
 * anchor with the current session, and injects them into the system
 * prompt so the agent picks up where work left off.
 *
 * Today: anchor-intersection match only. Vector-similarity recall comes
 * with Phase B (semantic memory).
 *
 * Cheap-by-design: scans `<workspace>/sessions/* /episodes/index.json`
 * files. No content reads unless caller asks for full Episode JSON.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  episodeIndexPath,
  type EpisodeAnchor,
  type EpisodeIndex,
  type EpisodeIndexEntry,
} from './episode.ts';
import { createLogger } from '../utils/debug.ts';

const log = createLogger('episode-retrieval');

// ============================================================================
// Public API
// ============================================================================

/** A retrieval hit — index entry plus its source-session-id (which we
 *  derive from the file path, not the entry itself). */
export interface RelevantEpisodeHit {
  sessionId: string;
  entry: EpisodeIndexEntry;
}

export interface RelevantEpisodeOptions {
  /** Workspace root path. */
  workspaceRoot: string;
  /** Anchors of the session asking for recall. */
  anchors: Array<{ type: string; id: string; title?: string }>;
  /**
   * Maximum episodes to return. Defaults to 5 — enough to give the agent
   * recent context without bloating the system prompt.
   */
  limit?: number;
  /**
   * If set, episodes from this session ID are excluded. Useful when you
   * only want CROSS-session recall (the current session's own prior
   * phases are visible elsewhere).
   */
  excludeSessionId?: string;
  /**
   * If set, ONLY episodes from this session ID are considered. Useful
   * for intra-session phase recall (the previous phase of the same
   * session, after an anchor-change).
   */
  onlySessionId?: string;
}

/**
 * Find episodes whose phase anchors intersect with the supplied anchors.
 * Returns newest endedAt first.
 *
 * Returns [] when:
 *   - workspace has no sessions/ directory
 *   - no episodes exist anywhere
 *   - the supplied anchors are empty (no signal to filter on)
 */
export function getRelevantEpisodes(opts: RelevantEpisodeOptions): RelevantEpisodeHit[] {
  if (!opts.anchors || opts.anchors.length === 0) return [];

  const sessionsDir = join(opts.workspaceRoot, 'sessions');
  if (!existsSync(sessionsDir)) return [];

  const anchorKeys = new Set(opts.anchors.map((a) => `${a.type}:${a.id}`));
  const limit = opts.limit ?? 5;

  const hits: RelevantEpisodeHit[] = [];

  let sessionDirs: string[];
  try {
    sessionDirs = readdirSync(sessionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    log.debug('readdir sessions/ failed', err);
    return [];
  }

  for (const sessionId of sessionDirs) {
    if (opts.excludeSessionId && sessionId === opts.excludeSessionId) continue;
    if (opts.onlySessionId && sessionId !== opts.onlySessionId) continue;

    const indexFile = episodeIndexPath(join(sessionsDir, sessionId));
    if (!existsSync(indexFile)) continue;

    let idx: EpisodeIndex;
    try {
      idx = JSON.parse(readFileSync(indexFile, 'utf-8')) as EpisodeIndex;
    } catch (err) {
      log.debug(`parse failed for ${indexFile}`, err);
      continue;
    }
    if (!idx?.entries) continue;

    for (const entry of idx.entries) {
      if (!anchorIntersects(entry.anchors, anchorKeys)) continue;
      hits.push({ sessionId, entry });
    }
  }

  hits.sort((a, b) => b.entry.endedAt.localeCompare(a.entry.endedAt));
  return hits.slice(0, limit);
}

function anchorIntersects(epAnchors: EpisodeAnchor[], anchorKeys: Set<string>): boolean {
  for (const a of epAnchors) {
    if (anchorKeys.has(`${a.type}:${a.id}`)) return true;
  }
  return false;
}

// ============================================================================
// Prompt-block rendering
// ============================================================================

/**
 * @deprecated B2 pivot (push→pull). The verbose per-turn injection of full
 * episode summaries is replaced by the lazy `recall` tool plus the slim
 * {@link renderRecallHintBlock} pointer. `getRelevantEpisodes` is retained as a
 * *cheap detector* (index-only scan) to decide whether the hint fires; this
 * renderer is kept only for tests / potential one-shot uses and is no longer
 * wired into prompt-builder. Prefer `renderRecallHintBlock`.
 *
 * Render hits as a `<relevant_episodes>` block ready to drop into a system
 * prompt. Returns null when there are no hits, so the caller can skip the
 * block entirely without conditionals.
 *
 * Format mirrors observations / conversation_tail — same envelope tag,
 * compact body, designed to read well as a snippet of LLM context.
 */
export function renderRelevantEpisodesBlock(hits: RelevantEpisodeHit[]): string | null {
  if (hits.length === 0) return null;

  const lines: string[] = [];
  for (const h of hits) {
    const e = h.entry;
    const anchors = e.anchors.map((a) => a.title ?? `${a.type}:${a.id}`).join(', ');
    const range = formatRange(e.startedAt, e.endedAt);
    const summary = (e.summarySnippet ?? '').replace(/\s+/g, ' ').trim();
    const counts = `${e.decisionsCount} decision${e.decisionsCount === 1 ? '' : 's'}, ` +
      `${e.openQuestionsCount} open Q, ${e.artifactsCount} artifact${e.artifactsCount === 1 ? '' : 's'}`;
    lines.push(
      `[${e.id} · session=${h.sessionId} · ${range} · anchor=${anchors} · outcome=${e.outcome}]\n` +
      `  ${summary || '(no summary)'}\n` +
      `  ${counts}`,
    );
  }

  return `<relevant_episodes>
Past phases relevant to your current anchors. Treat as memory of prior work — extend, don't restart. The newest entry is first; pay particular attention to outcome=handoff and any open questions.

${lines.join('\n\n')}
</relevant_episodes>`;
}

/**
 * Render a *slim* recall pointer — the B2-pivot replacement for the verbose
 * episode push-injection. Instead of dumping full summaries every turn, we tell
 * the agent that prior cross-anchor work exists and that it should pull the
 * detail on demand via the `recall` tool. Cheap to carry, self-suppressing
 * (returns null when there is nothing to recall).
 *
 * `sessionAnchors` is used to narrow the listed anchors to those the current
 * session actually shares with the hits — so the pointer names the axis the
 * agent should query, not every anchor the past phases happened to touch.
 */
export function renderRecallHintBlock(
  hits: RelevantEpisodeHit[],
  sessionAnchors: Array<{ type: string; id: string }>,
): string | null {
  if (hits.length === 0) return null;

  const sessionKeys = new Set(sessionAnchors.map((a) => `${a.type}:${a.id}`));
  const shared = new Map<string, EpisodeAnchor>();
  for (const h of hits) {
    for (const a of h.entry.anchors) {
      const key = `${a.type}:${a.id}`;
      if (sessionKeys.has(key)) shared.set(key, a);
    }
  }
  if (shared.size === 0) return null;

  const sessions = new Set(hits.map((h) => h.sessionId));
  const anchorList = [...shared.values()]
    .map((a) => `${a.title ?? a.id} (anchorType=${a.type}, anchorId=${a.id})`)
    .join('; ');

  const phaseWord = hits.length === 1 ? 'phase' : 'phases';
  const sessWord = sessions.size === 1 ? 'session' : 'sessions';

  return `<relevant_memory>
${hits.length} past ${phaseWord} across ${sessions.size} ${sessWord} share your current anchors: ${anchorList}.
Before restarting work tied to these anchors, call the \`recall\` tool with the matching anchorType/anchorId (or a text query) to load that prior context. This pointer is deliberately compact — recall fetches the detail on demand.
</relevant_memory>`;
}

function formatRange(startedAt: string, endedAt: string): string {
  try {
    const s = new Date(startedAt);
    const e = new Date(endedAt);
    const opts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' };
    return `${s.toLocaleString(undefined, opts)} → ${e.toLocaleString(undefined, opts)}`;
  } catch {
    return `${startedAt} → ${endedAt}`;
  }
}
