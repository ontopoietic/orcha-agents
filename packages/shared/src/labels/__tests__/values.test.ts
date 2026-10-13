import { describe, test, expect } from 'bun:test';
import { extractLabelId, toggleLabelInList, validateLabelValue, formatDisplayValue, LabelEntrySet } from '../values.ts';

describe('extractLabelId', () => {
  test('returns the entry verbatim for boolean labels', () => {
    expect(extractLabelId('bug')).toBe('bug');
  });

  test('strips the value portion from valued entries', () => {
    expect(extractLabelId('priority::3')).toBe('priority');
    expect(extractLabelId('due::2026-01-30')).toBe('due');
    // Values containing :: are preserved on the right side; only the first split matters.
    expect(extractLabelId('url::https://a::b')).toBe('url');
  });
});

describe('toggleLabelInList', () => {
  test('appends a label that is not present', () => {
    expect(toggleLabelInList(['bug'], 'urgent')).toEqual(['bug', 'urgent']);
  });

  test('removes a label that is present', () => {
    expect(toggleLabelInList(['bug', 'urgent'], 'bug')).toEqual(['urgent']);
  });

  test('removes all entries matching the base id (handles valued labels)', () => {
    // Toggling "priority" removes "priority::3" too — same logical label.
    expect(toggleLabelInList(['priority::3', 'bug'], 'priority')).toEqual(['bug']);
  });

  test('returns a new array (does not mutate input)', () => {
    const start = ['bug'];
    const after = toggleLabelInList(start, 'bug');
    expect(after).toEqual([]);
    expect(after).not.toBe(start);
    expect(start).toEqual(['bug']);
  });

  test('feeding the result back in compounds correctly under multi-toggle', () => {
    // The race that motivated the optimistic-state hook: rapid taps must
    // not lose updates. Each call is fed the previous result, simulating
    // the optimistic-state setter chaining through React's queue.
    const afterA = toggleLabelInList([], 'A');
    expect(afterA).toEqual(['A']);
    const afterAB = toggleLabelInList(afterA, 'B');
    expect(afterAB).toEqual(['A', 'B']);
    const afterB = toggleLabelInList(afterAB, 'A');
    expect(afterB).toEqual(['B']);
    const afterEmpty = toggleLabelInList(afterB, 'B');
    expect(afterEmpty).toEqual([]);
  });
});

describe('validateLabelValue', () => {
  test('string is always valid', () => {
    expect(validateLabelValue('anything', 'string')).toBe(true);
    expect(validateLabelValue('', 'string')).toBe(true);
  });

  test('link is always valid (URL/protocol safety is enforced at open time)', () => {
    expect(validateLabelValue('https://example.com', 'link')).toBe(true);
    expect(validateLabelValue('example.com', 'link')).toBe(true);
    expect(validateLabelValue('not a url', 'link')).toBe(true);
  });

  test('number accepts decimals, rejects non-numeric and scientific notation', () => {
    expect(validateLabelValue('3', 'number')).toBe(true);
    expect(validateLabelValue('0.5', 'number')).toBe(true);
    expect(validateLabelValue('high', 'number')).toBe(false);
    expect(validateLabelValue('3e5', 'number')).toBe(false);
  });

  test('date accepts valid ISO dates, rejects impossible ones', () => {
    expect(validateLabelValue('2026-01-30', 'date')).toBe(true);
    expect(validateLabelValue('2026-02-30', 'date')).toBe(false);
    expect(validateLabelValue('Jan-30-2026', 'date')).toBe(false);
  });
});

describe('formatDisplayValue', () => {
  test('strings pass through unchanged', () => {
    expect(formatDisplayValue('TASK-123', 'string')).toBe('TASK-123');
  });

  test('links get scheme and trailing slash stripped for display', () => {
    expect(formatDisplayValue('https://example.com', 'link')).toBe('example.com');
    expect(formatDisplayValue('https://example.com/path/', 'link')).toBe('example.com/path');
    expect(formatDisplayValue('http://example.com/x', 'link')).toBe('example.com/x');
  });

  test('scheme-less link values display as-is', () => {
    expect(formatDisplayValue('example.com/path', 'link')).toBe('example.com/path');
  });
});

describe('LabelEntrySet', () => {
  test('a plain entry is present when the label is there in any form', () => {
    const set = new LabelEntrySet(['bug::bug', 'trip::', 'priority::3']);
    expect(set.has('bug')).toBe(true);
    expect(set.has('bug::')).toBe(true);
    expect(set.has('trip')).toBe(true);
    expect(set.has('priority')).toBe(true);
    expect(set.has('code')).toBe(false);
  });

  test('a valued entry needs the same value: exact by default, case-folded where the rule says so', () => {
    const exact = new LabelEntrySet(['doc::https://youtu.be/dQw4w9WgXcQ', 'bug']);
    expect(exact.has('doc::https://youtu.be/dQw4w9WgXcQ')).toBe(true);
    expect(exact.has('doc::https://youtu.be/dqw4w9wgxcq')).toBe(false);
    // A plain entry says nothing about values
    expect(exact.has('bug::Bug')).toBe(false);

    const folded = new LabelEntrySet(['linear-issue::CRA-1', 'doc::https://a.io/X'], id => id === 'linear-issue');
    expect(folded.has('linear-issue::cra-1')).toBe(true);
    expect(folded.has('linear-issue::CRA-2')).toBe(false);
    expect(folded.has('doc::https://a.io/x')).toBe(false);
  });

  test('values keep everything after the first separator', () => {
    const set = new LabelEntrySet(['url::https://a::b']);
    expect(set.has('url::https://a::b')).toBe(true);
    expect(set.has('url::https://a')).toBe(false);
  });

  test('add extends the set', () => {
    const set = new LabelEntrySet();
    expect(set.has('bug')).toBe(false);
    set.add('bug::Bug');
    expect(set.has('bug')).toBe(true);
    expect(set.has('bug::Bug')).toBe(true);
  });
});
