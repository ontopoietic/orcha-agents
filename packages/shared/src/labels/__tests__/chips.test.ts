import { describe, test, expect } from 'bun:test';
import type { LabelConfig } from '../types.ts';
import { sessionLabelChips } from '../chips.ts';

const LABELS: LabelConfig[] = [
  { id: 'bug', name: 'Bug' },
  { id: 'code', name: 'Code' },
  { id: 'priority', name: 'Priority', valueType: 'number' },
  { id: 'customer', name: 'Customer', valueType: 'string' },
];

describe('sessionLabelChips', () => {
  test('collapses every entry of a plain label into one chip without a value', () => {
    const chips = sessionLabelChips(['bug::bug', 'code::git', 'bug::BUG', 'bug', 'code::Git'], LABELS);
    expect(chips).toEqual([
      { key: 'bug', label: LABELS[0]! },
      { key: 'code', label: LABELS[1]! },
    ]);
  });

  test('keeps one chip per valued entry, pointing at its own entry', () => {
    const chips = sessionLabelChips(['customer::acme', 'bug', 'customer::globex', 'priority::3'], LABELS);
    expect(chips.map(chip => [chip.key, chip.rawValue, chip.entryIndex])).toEqual([
      ['customer:0', 'acme', 0],
      ['bug', undefined, undefined],
      ['customer:2', 'globex', 2],
      ['priority:3', '3', 3],
    ]);
  });

  test('skips entries whose label is not configured', () => {
    expect(sessionLabelChips(['Scheduled', '', 'bug'], LABELS).map(chip => chip.key)).toEqual(['bug']);
  });
});
