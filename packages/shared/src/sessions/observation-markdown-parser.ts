/**
 * Parser for the canonical Markdown observation format.
 *
 * Spec: ./observation-format.md
 *
 * Used by:
 * - scripts/orcha-observe.ts to parse LLM output into Observation records
 * - apps/electron renderer to display observations.md in the UI
 *
 * The parser is intentionally permissive (skip + log instead of throw) so
 * malformed LLM output degrades to fewer observations rather than crashing
 * the observer run.
 */

export type Salience = 'pivotal' | 'question' | 'context';

export interface ParsedBullet {
  /** Salience derived from emoji prefix. */
  salience: Salience;
  /** Local time string from the bullet, format HH:mm. */
  time: string;
  /** Summary text — may already have sub-bullet details appended via " — ". */
  summary: string;
  /** Anchor short ID if present (last 6 chars of source msg-ID). */
  anchorShortId: string | null;
  /** Date header this bullet belongs to (YYYY-MM-DD), or null if none seen yet. */
  date: string | null;
}

const BULLET_RE = /^- (🔴|🟡|🟢)\s+(\d{2}:\d{2})\s+(.+?)(?:\s\{([a-z0-9]+)\})?\s*$/;
const SUB_BULLET_RE = /^ {2}- (.+?)\s*$/;
const DATE_HEADER_RE = /^# (\d{4}-\d{2}-\d{2})\s*$/;

const EMOJI_TO_SALIENCE: Record<string, Salience> = {
  '🔴': 'pivotal',
  '🟡': 'question',
  '🟢': 'context',
};

/**
 * Parse a Markdown observation block into structured bullets.
 *
 * Returns null if the input contains no bullets at all (caller can then
 * decide to fall back to a JSON parser or pattern matching).
 *
 * Sub-bullets (2-space indent, no emoji) are concatenated onto the previous
 * top-level bullet's summary, separated by " — ", capped at 280 chars.
 */
export function parseObservationsMarkdown(raw: string): ParsedBullet[] | null {
  if (!raw) return null;
  let text = raw.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '').trim();
  }
  if (!/^- (🔴|🟡|🟢)/m.test(text)) return null;

  const lines = text.split(/\r?\n/);
  const result: ParsedBullet[] = [];
  let currentDate: string | null = null;
  let lastBullet: ParsedBullet | null = null;

  for (const rawLine of lines) {
    const dateMatch = DATE_HEADER_RE.exec(rawLine);
    if (dateMatch) {
      currentDate = dateMatch[1] ?? null;
      lastBullet = null;
      continue;
    }

    const bulletMatch = BULLET_RE.exec(rawLine);
    if (bulletMatch) {
      const emoji = bulletMatch[1];
      const time = bulletMatch[2];
      const summary = bulletMatch[3];
      const anchor = bulletMatch[4];
      const salience = emoji ? EMOJI_TO_SALIENCE[emoji] : undefined;
      const trimmed = summary?.trim();
      if (!salience || !trimmed || !time) {
        lastBullet = null;
        continue;
      }
      const bullet: ParsedBullet = {
        salience,
        time,
        summary: trimmed,
        anchorShortId: anchor ?? null,
        date: currentDate,
      };
      result.push(bullet);
      lastBullet = bullet;
      continue;
    }

    const subMatch = SUB_BULLET_RE.exec(rawLine);
    if (subMatch && subMatch[1] && lastBullet) {
      const detail = subMatch[1].trim();
      if (detail && lastBullet.summary.length + detail.length + 3 <= 280) {
        lastBullet.summary = `${lastBullet.summary} — ${detail}`;
      }
      continue;
    }

    if (rawLine.trim() === '') lastBullet = null;
  }

  return result;
}

/**
 * Resolve a short anchor ID against a set of candidate IDs (e.g. msg-IDs
 * from a conversation slice). Match is on the last N chars of each
 * candidate, where N is the length of the short ID.
 */
export function resolveAnchorShortId<T extends { id: string }>(
  shortId: string,
  candidates: readonly T[],
): T | null {
  if (!shortId) return null;
  const target = shortId.toLowerCase();
  for (const c of candidates) {
    const id = c.id;
    if (!id) continue;
    const tail = id.slice(-target.length).toLowerCase();
    if (tail === target) return c;
    const dashSplit = id.split('-');
    const last = dashSplit[dashSplit.length - 1];
    if (last && last.toLowerCase() === target) return c;
  }
  return null;
}
