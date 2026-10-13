import { describe, expect, it } from 'bun:test'
import { MAX_INLINE_PDF_BYTES, largePdfNote, shouldInlinePdf } from '../pdf-inline.ts'

describe('shouldInlinePdf', () => {
  it('inlines PDFs up to the limit and sends bigger ones by path', () => {
    expect(shouldInlinePdf({ size: 2_000_000, base64: 'x' })).toBe(true)
    expect(shouldInlinePdf({ size: MAX_INLINE_PDF_BYTES, base64: 'x' })).toBe(true)
    expect(shouldInlinePdf({ size: 59_740_351, base64: 'x' })).toBe(false)
  })

  it('derives the size from the base64 when none is declared, and needs the bytes to inline', () => {
    expect(shouldInlinePdf({ base64: 'A'.repeat(4_000) })).toBe(true)
    expect(shouldInlinePdf({ size: 1_000 })).toBe(false)
  })

  it('tells the agent to read the stored file page range by page range', () => {
    expect(largePdfNote({ name: 'lecture.pdf', size: 59_740_351 })).toContain('lecture.pdf is too large to attach inline (59.7 MB)')
    expect(largePdfNote({ name: 'lecture.pdf', size: 59_740_351 })).toContain('Read tool')
  })
})
