import { describe, expect, it } from 'bun:test'
import { fitLabelCount } from '../fit-labels'

describe('whole session-row label chips', () => {
  it('keeps every chip at the exact full-fit boundary without reserving a needless counter', () => {
    expect(fitLabelCount([50, 40, 30], 128, 24)).toBe(3)
  })
  it('reserves the overflow count and gaps before choosing visible chips', () => {
    expect(fitLabelCount([50, 40, 30], 127, 24)).toBe(2)
    expect(fitLabelCount([50, 40, 30], 100, 24)).toBe(1)
  })
  it('shows only the counter when the first chip is too wide, preserving label order', () => {
    expect(fitLabelCount([140, 20], 100, 24)).toBe(0)
  })
  it('handles empty and zero-width containers without a partial chip', () => {
    expect(fitLabelCount([], 0, 24)).toBe(0)
    expect(fitLabelCount([30], 0, 24)).toBe(0)
  })
})
