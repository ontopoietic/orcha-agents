/**
 * Claude subscription quota messages (Fork §: connection failover).
 *
 * When a Claude Max/Pro account runs out of quota the SDK ends the turn with text like
 *   "Claude Code returned an error result: You've hit your session limit · resets 5:50pm (Europe/Berlin)"
 *   "You've hit your org's monthly spend limit · … · your weekly limit resets 9pm (Europe/Berlin)"
 * These are not short 429 throttles: they last until the stated reset time.
 */

const USAGE_LIMIT_PATTERNS: RegExp[] = [
  /you(?:'|’)ve hit your [^·\n]*limit/i,
  /\busage limit (?:reached|exceeded)\b/i,
  /\b(?:session|weekly|monthly|daily) limit reached\b/i,
  /\bspend limit\b/i,
]

/** True when the text is a subscription quota message (not a transient 429). */
export function isUsageLimitText(text: string): boolean {
  return USAGE_LIMIT_PATTERNS.some(pattern => pattern.test(text))
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** Wall-clock parts of `atMs` in `timeZone` (falls back to the local zone). */
function wallClock(atMs: number, timeZone?: string): { year: number; month: number; day: number; minutes: number } {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    }).formatToParts(new Date(atMs))
  } catch {
    // Unknown zone name: read the local wall clock instead.
    return wallClock(atMs, undefined)
  }
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0)
  return { year: get('year'), month: get('month'), day: get('day'), minutes: get('hour') * 60 + get('minute') }
}

/**
 * Epoch ms of the reset time named in a quota message ("resets 5:50pm (Europe/Berlin)",
 * "resets Oct 30, 9pm (Europe/Berlin)"), or undefined when the text names none.
 * The time is the next occurrence after `nowMs` in the stated zone.
 */
export function parseLimitResetTime(text: string, nowMs: number = Date.now()): number | undefined {
  const match = text.match(
    /resets\s+(?:(?:on\s+)?([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/i,
  )
  if (!match) return undefined
  const [, monthName, dayText, hourText, minuteText, meridiem, zone] = match
  let hour = Number(hourText) % 12
  if (meridiem!.toLowerCase() === 'pm') hour += 12
  const targetMinutes = hour * 60 + Number(minuteText ?? 0)

  const now = wallClock(nowMs, zone?.trim())
  let deltaMinutes = targetMinutes - now.minutes

  const monthIndex = monthName ? MONTHS.indexOf(monthName.toLowerCase()) : -1
  if (monthIndex >= 0 && dayText) {
    // Whole days between today and the named date (in the zone's calendar).
    const today = Date.UTC(now.year, now.month - 1, now.day)
    let target = Date.UTC(now.year, monthIndex, Number(dayText))
    if (target < today) target = Date.UTC(now.year + 1, monthIndex, Number(dayText))
    deltaMinutes += Math.round((target - today) / 60_000)
  }
  if (deltaMinutes <= 0) deltaMinutes += 24 * 60

  // Snap to the minute so repeated parses of the same text agree.
  const nowMinute = Math.floor(nowMs / 60_000) * 60_000
  return nowMinute + deltaMinutes * 60_000
}
