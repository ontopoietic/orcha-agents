import { describe, it, expect } from 'bun:test'
import type { LabelConfig, SemanticAutoLabelRule } from '../types.ts'
import type { DecisionRequest, DecisionResult } from '../../decisions/types.ts'
import type { AutoLabelMatch } from './types.ts'
import {
  autoLabelMatchToEntry,
  buildSemanticAutoLabelRequest,
  collectAutoLabelRules,
  collectSemanticAutoLabelRules,
  evaluateAutoLabels,
  evaluateSemanticAutoLabels,
  newAutoLabelEntries,
  semanticRuleEntry,
} from './evaluator.ts'
import { validateSemanticAutoLabelRule } from './validation.ts'

const LABELS: LabelConfig[] = [
  {
    id: 'linear-issue',
    name: 'Linear Issue',
    valueType: 'string',
    autoRules: [{ pattern: '\\b([A-Z]{2,5}-\\d+)\\b', valueTemplate: '$1' }],
  },
  {
    id: 'billing',
    name: 'Billing',
    autoRules: [{ semantic: 'Is the user asking about billing, invoices or charges?' }],
  },
  {
    id: 'area',
    name: 'Area',
    valueType: 'string',
    children: [
      {
        id: 'mobile',
        name: 'Mobile',
        valueType: 'string',
        autoRules: [{ semantic: 'Is this about the iOS or Android app?', threshold: 0.6, value: 'mobile-app' }],
      },
    ],
  },
]

function resultFor(request: DecisionRequest, nouls: number[]): DecisionResult {
  const answers: DecisionResult['answers'] = {}
  Object.keys(request.questions).forEach((key, i) => { answers[key] = { type: 'noul', noul: nouls[i] ?? 0 } })
  return {
    model: 'jev-1.13.0',
    modelReported: true,
    requestedModel: 'jev-1.13.0',
    answers,
    usage: { inputTokens: 10, outputTokens: 1 },
    latencyMs: 40,
    state: { sha256: 'x', bytes: 10, truncated: false },
  }
}

describe('auto-label rules: regex path stays synchronous and ignores semantic rules', () => {
  it('collects both kinds but evaluates only regex rules synchronously', () => {
    expect(collectAutoLabelRules(LABELS)).toHaveLength(3)
    expect(collectSemanticAutoLabelRules(LABELS).map(r => r.label.id)).toEqual(['billing', 'mobile'])
    const matches = evaluateAutoLabels('Please look at CRA-123, my invoice is wrong', LABELS)
    expect(matches).toEqual([{ labelId: 'linear-issue', value: 'CRA-123', matchedText: 'CRA-123', via: 'regex' }])
  })

  it('formats entries: id::value for a valued match, the bare id otherwise', () => {
    expect(autoLabelMatchToEntry({ labelId: 'linear-issue', value: 'CRA-1', matchedText: 'CRA-1', via: 'regex' })).toBe('linear-issue::CRA-1')
    // An empty capture applies the plain label (older sessions may carry `budget::`; LabelEntrySet treats both as one)
    expect(autoLabelMatchToEntry({ labelId: 'budget', value: '', matchedText: '$', via: 'regex' })).toBe('budget')
    expect(autoLabelMatchToEntry({ labelId: 'billing', value: '', matchedText: 'q', via: 'semantic' })).toBe('billing')
    expect(autoLabelMatchToEntry({ labelId: 'area', value: 'mobile-app', matchedText: 'q', via: 'semantic' })).toBe('area::mobile-app')
  })

  it('treats a hybrid pattern+semantic rule as a regex rule everywhere', () => {
    const hybrid: LabelConfig[] = [{ id: 'h', name: 'H', autoRules: [{ pattern: 'foo', semantic: 'Is it foo?' } as never] }]
    expect(collectSemanticAutoLabelRules(hybrid)).toHaveLength(0)
    expect(evaluateAutoLabels('foo bar', hybrid)).toHaveLength(1)
  })
})

describe('plain labels (no valueType) are presence-only', () => {
  const TREE: LabelConfig[] = [
    { id: 'bug', name: 'Bug', autoRules: [{ pattern: 'bug', flags: 'gi' }] },
    { id: 'code', name: 'Code', autoRules: [{ pattern: '(git)', valueTemplate: '$1' }, { pattern: 'feature implementation' }] },
    { id: 'linear-issue', name: 'Linear Issue', valueType: 'string', autoRules: [{ pattern: '\\b([A-Z]{2,5}-\\d+)\\b', valueTemplate: '$1' }] },
  ]

  it('applies the bare id once per message, whatever the match spelled or captured', () => {
    const matches = evaluateAutoLabels('Bug: the bug in git is a BUG; Git feature implementation', TREE)
    expect(matches.map(autoLabelMatchToEntry)).toEqual(['bug', 'code'])
    expect(matches[0]).toEqual({ labelId: 'bug', value: '', matchedText: 'Bug', via: 'regex' })
  })

  it('dedupes values case-insensitively within a message, keeping the first spelling', () => {
    expect(evaluateAutoLabels('CRA-1, cra-1 and CRA-2', TREE).map(autoLabelMatchToEntry)).toEqual(['linear-issue::CRA-1', 'linear-issue::CRA-2'])
  })

  it('semantic rules ignore a value on a plain label', async () => {
    const tree: LabelConfig[] = [{ id: 'trip', name: 'Trip', autoRules: [{ semantic: 'Is the user planning a trip?', value: 'yes' }] }]
    expect(semanticRuleEntry(tree[0]!, tree[0]!.autoRules![0] as SemanticAutoLabelRule)).toBe('trip')
    const matches = await evaluateSemanticAutoLabels('We are planning a weekend trip to Vienna', tree, async (request) => resultFor(request, [0.99]))
    expect(matches.map(autoLabelMatchToEntry)).toEqual(['trip'])
  })

  it('a legacy `trip::` entry counts as the label: the rule is not asked again', async () => {
    let calls = 0
    const tree: LabelConfig[] = [{ id: 'trip', name: 'Trip', autoRules: [{ semantic: 'Is the user planning a trip?' }] }]
    const decide = async (request: DecisionRequest) => { calls += 1; return resultFor(request, [1]) }
    expect(await evaluateSemanticAutoLabels('We are planning a weekend trip to Vienna', tree, decide, { skipEntries: ['trip::'] })).toEqual([])
    expect(calls).toBe(0)
  })
})

describe('newAutoLabelEntries', () => {
  const match = (labelId: string, value = ''): AutoLabelMatch => ({ labelId, value, matchedText: labelId, via: 'regex' })
  const TREE: LabelConfig[] = [
    { id: 'bug', name: 'Bug' },
    { id: 'code', name: 'Code' },
    { id: 'trip', name: 'Trip' },
    { id: 'linear-issue', name: 'Linear Issue', valueType: 'string' },
    { id: 'doc', name: 'Doc', valueType: 'link' },
    { id: 'budget', name: 'Budget', valueType: 'number' },
  ]

  it('adds nothing a session already has by meaning, including values older versions stored on plain labels', () => {
    const legacy = ['bug::bug', 'bug::Bug', 'code::git', 'trip::', 'linear-issue::cra-1']
    expect(newAutoLabelEntries(legacy, [match('bug'), match('code'), match('trip'), match('linear-issue', 'CRA-1')], TREE)).toEqual([])
  })

  it('adds new labels and values once each, valued matches first', () => {
    expect(newAutoLabelEntries(['bug'], [
      match('code'), match('linear-issue', 'CRA-2'), match('code'), match('linear-issue', 'cra-2'), match('bug'),
    ], TREE)).toEqual(['linear-issue::CRA-2', 'code'])
  })

  it('folds case for string values only: links stay exact', () => {
    expect(newAutoLabelEntries(['doc::https://youtu.be/dQw4w9WgXcQ'], [match('doc', 'https://youtu.be/dqw4w9wgxcq')], TREE))
      .toEqual(['doc::https://youtu.be/dqw4w9wgxcq'])
  })

  it('applies a label matched with and without a value once, with its value, in either order', () => {
    expect(newAutoLabelEntries([], [match('budget'), match('budget', '5000')], TREE)).toEqual(['budget::5000'])
    expect(newAutoLabelEntries([], [match('budget', '5000'), match('budget')], TREE)).toEqual(['budget::5000'])
  })
})

describe('evaluateAutoLabels: valued labels', () => {
  const TREE: LabelConfig[] = [
    { id: 'budget', name: 'Budget', valueType: 'number', autoRules: [{ pattern: 'budget(?:\\s*\\$(\\d+k?))?' }, { pattern: '\\$(\\d+k)' }] },
    { id: 'due', name: 'Due', valueType: 'date', autoRules: [{ pattern: 'due(?: (\\S+))?' }] },
    { id: 'linear-issue', name: 'Linear Issue', valueType: 'string', autoRules: [{ pattern: '\\b([A-Z]{2,5}-\\d+)\\b', valueTemplate: '$1' }] },
  ]

  it('applies the bare label when an optional group took no part or the value is invalid for the type', () => {
    expect(evaluateAutoLabels('what is the budget?', TREE).map(autoLabelMatchToEntry)).toEqual(['budget'])
    expect(evaluateAutoLabels('when is it due tomorrow', TREE).map(autoLabelMatchToEntry)).toEqual(['due'])
    expect(evaluateAutoLabels('it is due 2026-11-02', TREE).map(autoLabelMatchToEntry)).toEqual(['due::2026-11-02'])
  })

  it('keeps only the value when a label matched both ways, whichever rule came first', () => {
    expect(evaluateAutoLabels('the budget is high: $5k', TREE).map(autoLabelMatchToEntry)).toEqual(['budget::5000'])
  })

  it('skips what the session already has before counting toward the cap', () => {
    const keys = Array.from({ length: 12 }, (_, i) => `CRA-${i + 1}`)
    const existing = keys.slice(0, 10).map(key => `linear-issue::${key}`)
    expect(evaluateAutoLabels(keys.join(' '), TREE, existing).map(m => m.value)).toEqual(['CRA-11', 'CRA-12'])
  })
})

describe('evaluateSemanticAutoLabels', () => {
  it('asks one noul per semantic rule on the code-stripped message and applies labels above the threshold', async () => {
    let seen: DecisionRequest | undefined
    const matches = await evaluateSemanticAutoLabels(
      'My invoice shows two charges. ```console.log("mobile")```',
      LABELS,
      async (request) => { seen = request; return resultFor(request, [0.96, 0.3]) },
    )
    expect(seen).toBeDefined()
    expect(Object.values(seen!.questions).map(q => q.type)).toEqual(['noul', 'noul'])
    expect(String(Object.values(seen!.questions)[0]!.instructions)).toContain('billing')
    expect((seen!.state as Record<string, string>).user_message).toBe('My invoice shows two charges.')
    expect(matches).toEqual([
      { labelId: 'billing', value: '', matchedText: 'Is the user asking about billing, invoices or charges?', via: 'semantic', probability: 0.96 },
    ])
  })

  it('skips rules whose label entry the session already has (no question asked)', async () => {
    let seen: DecisionRequest | undefined
    const matches = await evaluateSemanticAutoLabels(
      'The Android app crashes when I open an invoice',
      LABELS,
      async (request) => { seen = request; return resultFor(request, [0.99]) },
      { skipEntries: new Set(['billing']) },
    )
    expect(Object.keys(seen!.questions)).toHaveLength(1)
    expect(String(Object.values(seen!.questions)[0]!.instructions)).toContain('Android')
    expect(matches.map(m => m.labelId)).toEqual(['mobile'])

    let calls = 0
    const all = new Set(collectSemanticAutoLabelRules(LABELS).map(({ label, rule }) => semanticRuleEntry(label, rule)))
    expect(all).toEqual(new Set(['billing', 'mobile::mobile-app']))
    expect(await evaluateSemanticAutoLabels('The Android app crashes on an invoice', LABELS, async (r) => { calls++; return resultFor(r, [1, 1]) }, { skipEntries: all })).toEqual([])
    expect(calls).toBe(0)
  })

  it('honours per-rule thresholds and fixed values', async () => {
    const matches = await evaluateSemanticAutoLabels('The Android app crashes on launch', LABELS, async (request) => resultFor(request, [0.85, 0.65]))
    // billing: 0.85 < default 0.9 → no; mobile: 0.65 >= 0.6 → yes with the fixed value
    expect(matches).toEqual([
      { labelId: 'mobile', value: 'mobile-app', matchedText: 'Is this about the iOS or Android app?', via: 'semantic', probability: 0.65 },
    ])
    expect(autoLabelMatchToEntry(matches[0]!)).toBe('mobile::mobile-app')
  })

  it('fails closed: no rules, empty or trivial message, null result, thrown error', async () => {
    let calls = 0
    const counting = async (request: DecisionRequest) => { calls += 1; return resultFor(request, [1, 1]) }
    expect(await evaluateSemanticAutoLabels('hello there, this is long enough', [LABELS[0]!], counting)).toEqual([])
    expect(await evaluateSemanticAutoLabels('```only code```', LABELS, counting)).toEqual([])
    expect(await evaluateSemanticAutoLabels('ok thanks', LABELS, counting)).toEqual([]) // below the length floor
    expect(calls).toBe(0)
    expect(await evaluateSemanticAutoLabels('hello there, this is long enough', LABELS, async () => null)).toEqual([])
    expect(await evaluateSemanticAutoLabels('hello there, this is long enough', LABELS, async () => { throw new Error('down') })).toEqual([])
  })

  it('chunks many rules into several calls', async () => {
    const many: LabelConfig[] = Array.from({ length: 45 }, (_, i) => ({
      id: `l${i}`,
      name: `L${i}`,
      autoRules: [{ semantic: `Question ${i}?` }],
    }))
    const sizes: number[] = []
    const matches = await evaluateSemanticAutoLabels('a message long enough to be judged', many, async (request) => {
      const n = Object.keys(request.questions).length
      sizes.push(n)
      return resultFor(request, Array.from({ length: n }, () => 0))
    })
    expect(sizes).toEqual([20, 20, 5])
    expect(matches).toEqual([])
  })

  it('buildSemanticAutoLabelRequest keys rules by position', () => {
    const request = buildSemanticAutoLabelRequest('msg', collectSemanticAutoLabelRules(LABELS))
    expect(Object.keys(request.questions)).toEqual(['rule_0', 'rule_1'])
  })
})

describe('validateSemanticAutoLabelRule', () => {
  it('accepts a plain question and flags bad thresholds', () => {
    expect(validateSemanticAutoLabelRule({ semantic: 'Is the user asking about billing?' }).valid).toBe(true)
    expect(validateSemanticAutoLabelRule({ semantic: '' }).valid).toBe(false)
    expect(validateSemanticAutoLabelRule({ semantic: 'Is it urgent?', threshold: 1.2 }).valid).toBe(false)
    expect(validateSemanticAutoLabelRule({ semantic: 'Is it urgent?', threshold: 0 }).valid).toBe(false)
    expect(validateSemanticAutoLabelRule({ semantic: 'Is it urgent?', threshold: 0.3 }).warnings.length).toBeGreaterThan(0)
    expect(validateSemanticAutoLabelRule({ semantic: 'billing stuff' }).warnings.length).toBeGreaterThan(0)
    expect(validateSemanticAutoLabelRule({ semantic: 'Is it urgent?', value: 5 as unknown as string }).valid).toBe(false)
  })
})
