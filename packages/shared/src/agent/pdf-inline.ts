/**
 * Which attached PDFs go to Claude inline (a base64 `document` block).
 *
 * The Messages API rejects requests over 32 MB, and an inline document stays in
 * the conversation, so every later turn re-sends it. Bigger PDFs are sent by
 * path only (the stored-file line the agent always gets) and read with the Read
 * tool, page range by page range; Pi sessions already send every PDF that way.
 */

/** Raw size up to which a PDF is attached inline */
export const MAX_INLINE_PDF_BYTES = 10 * 1024 * 1024

/** Raw size of an attachment: its declared size, else derived from its base64 */
function rawBytes(attachment: { size?: number; base64?: string }): number {
  if (typeof attachment.size === 'number' && attachment.size > 0) return attachment.size
  return attachment.base64 ? Math.floor((attachment.base64.length * 3) / 4) : 0
}

export function shouldInlinePdf(attachment: { size?: number; base64?: string }): boolean {
  return !!attachment.base64 && rawBytes(attachment) <= MAX_INLINE_PDF_BYTES
}

/** Tells the agent how to read a PDF that was not attached inline */
export function largePdfNote(attachment: { name: string; size?: number; base64?: string }): string {
  const mb = (rawBytes(attachment) / 1_000_000).toFixed(1)
  return `[${attachment.name} is too large to attach inline (${mb} MB). Read it from the stored path above with the Read tool, using the pages parameter for page ranges.]`
}
