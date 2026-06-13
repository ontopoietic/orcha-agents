/**
 * Parse the observation block emitted by the Mastra Observer (orcha variant)
 * into structured bullets carrying salience + time + anchor.
 *
 * Input is the markdown body inside `<observations>...</observations>`
 * — already extracted by `parseObserverOutput`. Shape:
 *
 *   Date: May 21, 2026
 *   * 🔴 (14:30) User chose feature-branch workflow {abc123}
 *     * -> Reason: prior main-push incident
 *   * 🟡 (14:31) Open question on DB choice {def456}
 *   ✅ (14:35) Auth refactor done {ghi789}
 *
 * Only top-level bullets (lines starting with `*` or `-`, at column 0 or
 * with minimal indent) are returned. Sub-bullets (deeper indent, `-> …`)
 * are captured as `subBullets` on their parent.
 *
 * Bullets without a parseable `{shortId}` anchor are returned with
 * `anchorShortId: null` so the caller can decide whether to drop them.
 */

export type AnchoredSalience = 'high' | 'medium' | 'low' | 'completed';

export interface AnchoredBullet {
  /** Original line, verbatim (without trailing newline). */
  raw: string;
  /** Salience derived from leading emoji. */
  salience: AnchoredSalience;
  /** Time prefix (HH:MM) if present, else null. */
  time: string | null;
  /** Bullet text WITHOUT salience emoji, time prefix, or trailing anchor. */
  summary: string;
  /** Anchor shortId extracted from trailing `{shortId}`, or null if missing. */
  anchorShortId: string | null;
  /** Sub-bullet lines associated with this bullet, indented under it. */
  subBullets: string[];
  /** Date header that grouped this bullet (verbatim, e.g. "May 21, 2026"). */
  dateHeader: string | null;
}

// 1:1 with Mastra's priority taxonomy (see parse-ledger.ts).
const SALIENCE_FROM_EMOJI: Record<string, AnchoredSalience> = {
  '🔴': 'high',
  '🟡': 'medium',
  '🟢': 'low',
  '✅': 'completed',
};

const SALIENCE_EMOJI_PATTERN = /^[\s]*[*-][\s]+(🔴|🟡|🟢|✅)/u;
const TIME_PATTERN = /\(?\b(\d{1,2}:\d{2})\)?/;
// Anchor at end of line. Tolerant of trailing whitespace.
const TRAILING_ANCHOR_PATTERN = /\{([A-Za-z0-9_-]{3,40})\}\s*$/;
// Mastra emits "Date: May 21, 2026"; we also tolerate `# 2026-05-21`.
const DATE_HEADER_PATTERN = /^(?:Date:\s*(.+)|#\s+(\d{4}-\d{2}-\d{2}))\s*$/;

function isTopLevelBullet(line: string): boolean {
  // Top-level bullet starts with optional 0-1 space + `*` or `-` + space.
  // Anything indented further is a sub-bullet.
  return /^[ \t]{0,1}[*-][ \t]/.test(line);
}

function isSubBullet(line: string): boolean {
  return /^[ \t]{2,}[*-][ \t]/.test(line) || /^[ \t]{2,}->/.test(line);
}

export function parseAnchoredBullets(observationBlock: string): AnchoredBullet[] {
  if (!observationBlock) return [];
  const bullets: AnchoredBullet[] = [];
  let currentDateHeader: string | null = null;
  let current: AnchoredBullet | null = null;

  const lines = observationBlock.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line) continue;

    const dateMatch = DATE_HEADER_PATTERN.exec(line);
    if (dateMatch) {
      currentDateHeader = (dateMatch[1] ?? dateMatch[2] ?? '').trim();
      continue;
    }

    if (isTopLevelBullet(line) && SALIENCE_EMOJI_PATTERN.test(line)) {
      // Flush previous bullet
      if (current) bullets.push(current);

      const emojiMatch = SALIENCE_EMOJI_PATTERN.exec(line);
      const emoji = emojiMatch?.[1] ?? '';
      const salience = SALIENCE_FROM_EMOJI[emoji] ?? 'low';

      // Body = line with leading "* 🔴 " stripped.
      let body = line.replace(SALIENCE_EMOJI_PATTERN, '').trimStart();

      // Extract time (e.g. "(14:30)" or "14:30")
      let time: string | null = null;
      const timeMatch = TIME_PATTERN.exec(body);
      if (timeMatch && body.startsWith(timeMatch[0])) {
        time = timeMatch[1] ?? null;
        body = body.slice(timeMatch[0].length).trimStart();
      }

      // Extract trailing anchor
      let anchorShortId: string | null = null;
      const anchorMatch = TRAILING_ANCHOR_PATTERN.exec(body);
      if (anchorMatch) {
        anchorShortId = anchorMatch[1] ?? null;
        body = body.slice(0, anchorMatch.index).trimEnd();
      }

      current = {
        raw: line,
        salience,
        time,
        summary: body,
        anchorShortId,
        subBullets: [],
        dateHeader: currentDateHeader,
      };
      continue;
    }

    if (current && isSubBullet(line)) {
      current.subBullets.push(line);
      continue;
    }

    // Lines outside the bullet/date grammar are ignored. We intentionally
    // do NOT throw — the LLM occasionally emits stray prose lines.
  }
  if (current) bullets.push(current);
  return bullets;
}
