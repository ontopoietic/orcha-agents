import { describe, it, expect } from 'bun:test'
import { validateLabelsContent } from '../../config/validators.ts'
import { hasCaptureGroup } from './validation.ts'

function labelsJson(autoRules: unknown[], valueType?: string): string {
  return JSON.stringify({ version: 1, labels: [{ id: 'billing', name: 'Billing', ...(valueType ? { valueType } : {}), autoRules }] })
}

describe('labels/config.json accepts semantic auto-rules', () => {
  it('accepts a semantic rule next to a regex rule', () => {
    const result = validateLabelsContent(labelsJson([
      { pattern: 'invoice', valueTemplate: '$0' },
      { semantic: 'Is the user asking about billing?', threshold: 0.85 },
    ]))
    expect(result.valid).toBe(true)
  })

  it('rejects rules with neither pattern nor semantic, hybrids, and bad thresholds — with field-level messages', () => {
    const neither = validateLabelsContent(labelsJson([{ patern: 'typo' }]))
    expect(neither.valid).toBe(false)
    expect(neither.errors.some(e => e.message.includes('"pattern"') && e.message.includes('"semantic"'))).toBe(true)

    const hybrid = validateLabelsContent(labelsJson([{ pattern: 'x', semantic: 'Is it x?' }]))
    expect(hybrid.valid).toBe(false)
    expect(hybrid.errors.some(e => e.message.includes('not both'))).toBe(true)

    const badThreshold = validateLabelsContent(labelsJson([{ semantic: 'Is it urgent?', threshold: 2 }]))
    expect(badThreshold.valid).toBe(false)
    expect(badThreshold.errors.some(e => e.message.includes('at most 1'))).toBe(true)

    const badFlags = validateLabelsContent(labelsJson([{ pattern: 'x', flags: 5 }]))
    expect(badFlags.valid).toBe(false)
    expect(badFlags.errors.some(e => e.path.includes('flags'))).toBe(true)

    expect(validateLabelsContent(labelsJson([{ semantic: '' }])).valid).toBe(false)
    expect(validateLabelsContent(labelsJson([{ semantic: 'Is it x?', valueTemplate: '$1' }])).valid).toBe(false)
  })
})

describe('labels/config.json: rules on plain labels store no value', () => {
  const warningsOf = (content: string) => validateLabelsContent(content).warnings.map(w => w.message)

  it('a presence pattern on a plain label is fine; a valueTemplate or semantic value there is flagged as ignored', () => {
    expect(warningsOf(labelsJson([{ pattern: 'invoice|bill' }]))).toEqual([])
    const template = validateLabelsContent(labelsJson([{ pattern: '(invoice)', valueTemplate: '$1' }]))
    expect(template.valid).toBe(true)
    expect(template.warnings.map(w => w.message)).toEqual([expect.stringContaining('valueTemplate is ignored')])
    expect(warningsOf(labelsJson([{ semantic: 'Is the user asking about billing?', value: 'yes' }])))
      .toEqual([expect.stringContaining('value is ignored')])
  })

  it('a valued label still hears about a pattern without capture groups, and accepts a semantic value', () => {
    expect(warningsOf(labelsJson([{ pattern: 'invoice' }], 'string'))).toEqual([expect.stringContaining('no capture groups')])
    expect(warningsOf(labelsJson([{ pattern: '(INV-\\d+)', valueTemplate: '$1' }], 'string'))).toEqual([])
    expect(warningsOf(labelsJson([{ semantic: 'Is the user asking about billing?', value: 'billing' }], 'string'))).toEqual([])
  })

  it('counts named groups as capture groups and accepts a constant template', () => {
    expect(warningsOf(labelsJson([{ pattern: '(?<key>INV-\\d+)' }], 'string'))).toEqual([])
    expect(warningsOf(labelsJson([{ pattern: 'git', valueTemplate: 'git' }], 'string'))).toEqual([])
    expect(hasCaptureGroup('(\\d+)')).toBe(true)
    expect(hasCaptureGroup('(?:a|b)')).toBe(false)
    expect(hasCaptureGroup('(?<=a)b(?!c)')).toBe(false)
    expect(hasCaptureGroup('\\(x\\) [(]')).toBe(false)
  })
})
