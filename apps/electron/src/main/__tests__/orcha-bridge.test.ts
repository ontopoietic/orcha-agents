import { describe, it, expect } from 'bun:test'
import { parseAnchorables } from '../orcha-bridge'

// ---------------------------------------------------------------------------
// Sample CLI outputs — captured live from `orcha {type} list` (2026-05-06).
// Trimmed but structurally faithful.
// ---------------------------------------------------------------------------

const featureSample = [
  {
    id: 'area-1',
    projectId: 'p1',
    name: 'Modul-System',
    description: null,
    sortOrder: 0,
    createdAt: '2026-05-05T15:30:54.314Z',
    features: [
      {
        id: 'feat-a',
        areaId: 'area-1',
        parentFeatureId: null,
        name: 'Modul-Registry',
        priority: 'must',
        tags: [],
      },
      {
        id: 'feat-b',
        areaId: 'area-1',
        parentFeatureId: 'feat-a',
        name: 'Versions-Verlauf',
        priority: 'should',
      },
    ],
  },
  {
    id: 'area-2',
    name: 'Anliegen-Pipeline',
    features: [{ id: 'feat-c', name: 'Transform-Endpoint', priority: 'must' }],
  },
]

const befundSample = [
  {
    id: 'bef-1',
    projectId: 'p1',
    title: 'Lifecycle-Schritt nicht im Modell verankert',
    description: 'Long description...',
    category: 'gap',
    status: 'open',
    resolvedByDecisionId: null,
  },
  {
    id: 'bef-2',
    title: 'Stale Edge in Feature-Graph',
    category: 'inconsistency',
    status: 'resolved',
  },
]

const anliegenSample = [
  {
    id: 'anl-1',
    projectId: 'p1',
    rawText: 'Die Validierung scheint zu inkonsistent zu sein, manche Routen prüfen, andere nicht.',
    form: 'wunsch',
    status: 'open',
  },
  {
    id: 'anl-2',
    raw_text: 'Snake-case fallback variant.',
    form: 'frage',
    status: 'transformed',
  },
]

// ---------------------------------------------------------------------------

describe('parseAnchorables: feature', () => {
  it('flattens areas[].features[] into AnchorableItems', () => {
    const items = parseAnchorables('feature', featureSample)
    expect(items.length).toBe(3)
    expect(items[0]).toMatchObject({ type: 'feature', id: 'feat-a', title: 'Modul-Registry' })
    expect(items[0].subtitle).toContain('Modul-System')
    expect(items[0].subtitle).toContain('must')
    expect(items[2]).toMatchObject({ type: 'feature', id: 'feat-c', title: 'Transform-Endpoint' })
  })

  it('skips features without id or name', () => {
    const broken = [
      { id: 'a', name: 'Area', features: [{ id: 'ok', name: 'Good' }, { id: 'no-name' }, { name: 'no-id' }] },
    ]
    const items = parseAnchorables('feature', broken)
    expect(items.length).toBe(1)
    expect(items[0].id).toBe('ok')
  })

  it('handles empty area list', () => {
    expect(parseAnchorables('feature', [])).toEqual([])
  })

  it('returns empty for non-array input', () => {
    expect(parseAnchorables('feature', null)).toEqual([])
    expect(parseAnchorables('feature', { features: [] })).toEqual([])
  })
})

describe('parseAnchorables: befund', () => {
  it('shapes flat findings list', () => {
    const items = parseAnchorables('befund', befundSample)
    expect(items.length).toBe(2)
    expect(items[0]).toMatchObject({ type: 'befund', id: 'bef-1', title: 'Lifecycle-Schritt nicht im Modell verankert' })
    expect(items[0].subtitle).toBe('gap · open')
    expect(items[1].subtitle).toBe('inconsistency · resolved')
  })

  it('skips entries missing id or title', () => {
    const items = parseAnchorables('befund', [{ id: 'x' }, { title: 'no-id' }, { id: 'ok', title: 'Good' }])
    expect(items.length).toBe(1)
    expect(items[0].id).toBe('ok')
  })
})

describe('parseAnchorables: anliegen', () => {
  it('reads rawText (camelCase) and raw_text (snake) as title fallbacks', () => {
    const items = parseAnchorables('anliegen', anliegenSample)
    expect(items.length).toBe(2)
    expect(items[0].id).toBe('anl-1')
    expect(items[0].title).toContain('Validierung')
    expect(items[1].title).toBe('Snake-case fallback variant.')
  })

  it('truncates very long titles to ~80 chars with ellipsis', () => {
    const longText = 'X'.repeat(200)
    const items = parseAnchorables('anliegen', [{ id: 'long', rawText: longText, status: 'open' }])
    expect(items.length).toBe(1)
    expect(items[0].title.length).toBeLessThanOrEqual(80)
    expect(items[0].title.endsWith('…')).toBe(true)
  })

  it('combines form and status into subtitle, omitting empty parts', () => {
    const items = parseAnchorables('anliegen', [{ id: 'a', rawText: 'x', form: 'wunsch' }])
    expect(items[0].subtitle).toBe('wunsch')
  })

  it('falls back to title field when neither rawText nor raw_text present', () => {
    const items = parseAnchorables('anliegen', [{ id: 'a', title: 'Plain title' }])
    expect(items[0].title).toBe('Plain title')
  })
})

describe('parseAnchorables: edge cases', () => {
  it('ignores null entries inside arrays', () => {
    const items = parseAnchorables('befund', [null, { id: 'a', title: 'Good' }, undefined])
    expect(items.length).toBe(1)
  })

  it('does not throw on deeply malformed shapes', () => {
    expect(() => parseAnchorables('feature', [{ features: 'not-an-array' }])).not.toThrow()
    expect(() => parseAnchorables('befund', [{ id: 123, title: 456 }])).not.toThrow()
  })
})
