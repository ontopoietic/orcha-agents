import { describe, test, expect } from 'bun:test';
import type { LabelConfig } from '../types.ts';
import { canonicalizeSessionLabels, foldsValueCase } from '../canonical.ts';

const LABELS: LabelConfig[] = [
  { id: 'development', name: 'Development', children: [{ id: 'bug', name: 'Bug' }, { id: 'code', name: 'Code' }] },
  { id: 'trip', name: 'Trip' },
  { id: 'priority', name: 'Priority', valueType: 'number' },
  { id: 'linear-issue', name: 'Linear Issue', valueType: 'string' },
  { id: 'doc', name: 'Doc', valueType: 'link' },
];

describe('canonicalizeSessionLabels', () => {
  test('turns what older auto-labelling stored into one bare entry per plain label', () => {
    expect(canonicalizeSessionLabels(
      ['task-x', 'bug::bug', 'trip::', 'bug::BUG', 'bug::Bug', 'code::git', 'code::Git'],
      LABELS,
    )).toEqual(['task-x', 'bug', 'trip', 'code']);
  });

  test('keeps values on valued labels, drops empty values and bare duplicates of a valued label', () => {
    expect(canonicalizeSessionLabels(['priority', 'priority::3', 'linear-issue::', 'doc::https://a.io/X'], LABELS))
      .toEqual(['priority::3', 'linear-issue', 'doc::https://a.io/X']);
  });

  test('dedupes string values case-insensitively and links exactly, keeping the first spelling', () => {
    expect(canonicalizeSessionLabels(
      ['linear-issue::CRA-1', 'linear-issue::cra-1', 'doc::https://a.io/X', 'doc::https://a.io/x', 'bug', 'bug'],
      LABELS,
    )).toEqual(['linear-issue::CRA-1', 'doc::https://a.io/X', 'doc::https://a.io/x', 'bug']);
  });

  test('leaves entries of unknown labels as they are and is idempotent', () => {
    const once = canonicalizeSessionLabels(['Scheduled', 'gone::v', 'bug::x'], LABELS);
    expect(once).toEqual(['Scheduled', 'gone::v', 'bug']);
    expect(canonicalizeSessionLabels(once, LABELS)).toEqual(once);
  });
});

describe('foldsValueCase', () => {
  test('folds string values only', () => {
    const folds = foldsValueCase(LABELS);
    expect(folds('linear-issue')).toBe(true);
    expect(folds('doc')).toBe(false);
    expect(folds('priority')).toBe(false);
    expect(folds('bug')).toBe(false);
  });
});
