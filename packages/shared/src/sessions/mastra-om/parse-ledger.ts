/**
 * Parser for the on-disk `observations.mastra.md` ledger.
 *
 * The file is the *content* the Mastra Observer emits inside the
 * `<observations>` wrapper — date headers + bullet list with priority
 * emojis. The XML wrapper is a transport convention; on disk we keep just
 * the body for grep/diff-friendliness.
 *
 * Date headers can appear in two shapes the Mastra Observer prompt
 * produces interchangeably:
 *
 *   Date: Dec 4, 2025
 *   Dec 4, 2025:
 *
 * Top-level bullets:
 *
 *   * 🔴 (14:30) User prefers direct answers
 *   * 🟡 (14:31) Working on feature X
 *   * 🟢 (14:32) Minor detail
 *   * ✅ (14:33) Auth task completed
 *
 * Sub-bullets (2-space indent under a parent), used for grouped tool
 * sequences or completions attached to a parent:
 *
 *     * -> viewed src/auth.ts — found token validation
 *     * ✅ Tests passing
 *
 * Salience mapping to our existing 3-way taxonomy (until UI gains a
 * dedicated 'completed' state):
 *   🔴 High      → 'pivotal'
 *   🟡 Medium    → 'context'    (project details, learned info, tool results —
 *                               contextual facts, NOT questions; Mastra has no
 *                               question class, so 'question' is legacy-only)
 *   🟢 Low       → 'context'
 *   ✅ Completed → 'pivotal'    (preserves visibility; closure is load-bearing)
 */

import type { Salience } from '../observation-markdown-parser.ts';

export interface MastraParsedBullet {
  salience: Salience;
  /** True iff the source bullet used ✅ (kept so UI can promote when ready). */
  completed: boolean;
  /** HH:MM 24-hour, or '' if the bullet had no time prefix. */
  time: string;
  /** Date the bullet falls under (YYYY-MM-DD) or null if no date header seen. */
  date: string | null;
  /** Headline text, with any sub-bullets folded in as " — detail" suffixes. */
  summary: string;
  /**
   * Orcha anchor shortId extracted from the trailing `{shortId}` of the
   * top-level bullet line, or null if the LLM omitted it. Sub-bullet anchors
   * are intentionally NOT propagated (see orcha-anchor-instruction.ts).
   */
  anchorShortId: string | null;
}

const DATE_HEADER_RE =
  /^(?:Date:\s*)?([A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4})\s*:?\s*$/;
// Top-level bullet: `* 🔴 (14:30) text` or `* ✅ text` (✅ may omit time)
const BULLET_RE =
  /^[*-]\s+(🔴|🟡|🟢|✅)\s+(?:\(([0-2]?\d:\d{2})(?:\s*[AP]M)?\)\s+)?(.+?)\s*$/u;
// Sub-bullet (2-space indent): `  * -> text` or `  * ✅ text` or `  * 🔴 (…) text`
const SUB_BULLET_RE = /^\s{2,}[*-]\s+(.+?)\s*$/;
// Trailing `{shortId}` (the orcha-anchor convention emitted by the LLM under
// our ORCHA_ANCHOR_INSTRUCTION override). 3-40 chars of [A-Za-z0-9_-].
const TRAILING_ANCHOR_RE = /\s*\{([A-Za-z0-9_-]{3,40})\}\s*$/;

const EMOJI_TO_SALIENCE: Record<string, { salience: Salience; completed: boolean }> = {
  '🔴': { salience: 'pivotal', completed: false },
  '🟡': { salience: 'context', completed: false },
  '🟢': { salience: 'context', completed: false },
  '✅': { salience: 'pivotal', completed: true },
};

function parseDateHeader(raw: string): string | null {
  const m = DATE_HEADER_RE.exec(raw);
  if (!m || !m[1]) return null;
  const d = new Date(m[1]);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Parse the Mastra ledger body into bullets. Returns `null` when no
 * recognizable top-level bullets are present (caller can decide whether to
 * treat that as "empty file" or "bail out").
 *
 * Permissive on purpose: a malformed sub-bullet or unexpected blank line
 * does not abort parsing, it just resets the "attach next sub-bullet here"
 * cursor.
 */
export function parseMastraLedger(raw: string): MastraParsedBullet[] | null {
  if (!raw) return null;
  const text = raw.replace(/\r\n/g, '\n').trim();
  if (!BULLET_RE.test(text.split('\n').find((l) => l.trim().length > 0) ?? '')) {
    // No bullets at all on first non-blank line is usually fine (file may
    // start with a date header) — fall through to full scan.
  }

  const lines = text.split('\n');
  const result: MastraParsedBullet[] = [];
  let currentDate: string | null = null;
  let lastBullet: MastraParsedBullet | null = null;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (line.trim() === '') {
      lastBullet = null;
      continue;
    }
    const date = parseDateHeader(line);
    if (date) {
      currentDate = date;
      lastBullet = null;
      continue;
    }

    const bulletMatch = BULLET_RE.exec(line);
    if (bulletMatch) {
      const [, emoji, time, summary] = bulletMatch;
      const mapping = emoji ? EMOJI_TO_SALIENCE[emoji] : undefined;
      if (!mapping || !summary) {
        lastBullet = null;
        continue;
      }
      let trimmedSummary = summary.trim();
      let anchorShortId: string | null = null;
      const anchorMatch = TRAILING_ANCHOR_RE.exec(trimmedSummary);
      if (anchorMatch) {
        anchorShortId = anchorMatch[1] ?? null;
        trimmedSummary = trimmedSummary.slice(0, anchorMatch.index).trimEnd();
      }
      const bullet: MastraParsedBullet = {
        salience: mapping.salience,
        completed: mapping.completed,
        time: time ?? '',
        date: currentDate,
        summary: trimmedSummary,
        anchorShortId,
      };
      result.push(bullet);
      lastBullet = bullet;
      continue;
    }

    const subMatch = SUB_BULLET_RE.exec(line);
    if (subMatch && subMatch[1] && lastBullet) {
      // Fold the sub-bullet onto the parent summary, stripping the leading
      // "-> " arrow that Mastra uses for tool-trace bullets so the display
      // stays clean.
      let detail = subMatch[1].trim().replace(/^->\s*/, '');
      // Strip a leading emoji from the sub-bullet so we don't double-render
      // it inside the summary text; if it was ✅, propagate that state up.
      const subEmojiMatch = /^(🔴|🟡|🟢|✅)\s*(?:\([^)]+\)\s*)?(.*)$/u.exec(detail);
      if (subEmojiMatch) {
        if (subEmojiMatch[1] === '✅') lastBullet.completed = true;
        detail = (subEmojiMatch[2] ?? '').trim();
      }
      if (!detail) continue;
      const combined = `${lastBullet.summary} — ${detail}`;
      // Soft cap to keep the surfaced summary readable in UI lists.
      lastBullet.summary = combined.length <= 600 ? combined : combined.slice(0, 597) + '…';
      continue;
    }

    // Anything else (paragraph, stray text) just breaks the attach cursor.
    lastBullet = null;
  }

  return result.length > 0 ? result : null;
}
