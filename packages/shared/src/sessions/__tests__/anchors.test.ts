import { describe, expect, it } from 'bun:test';
import {
  ANCHOR_TYPES,
  type AnchorRef,
  anchorKey,
  anchorsEqual,
  validateAnchor,
  validateAnchorsLenient,
} from '../anchors.ts';
import { SESSION_PERSISTENT_FIELDS } from '../types.ts';
import { pickSessionFields } from '../utils.ts';

const sample: AnchorRef = {
  type: 'feature',
  id: 'feat-abc-123',
  title: 'Modul-System v1',
  addedAt: '2026-05-06T14:00:00.000Z',
  addedBy: 'user',
};

describe('AnchorRef shape', () => {
  it('exposes the canonical anchor types', () => {
    expect(ANCHOR_TYPES).toEqual(['feature', 'befund', 'anliegen']);
  });

  it('anchorKey produces stable type:id keys', () => {
    expect(anchorKey(sample)).toBe('feature:feat-abc-123');
  });

  it('anchorsEqual compares by type+id, ignoring snapshot/meta', () => {
    const renamed: AnchorRef = { ...sample, title: 'Renamed', addedAt: 'x', addedBy: 'agent' };
    expect(anchorsEqual(sample, renamed)).toBe(true);
    const other: AnchorRef = { ...sample, id: 'different' };
    expect(anchorsEqual(sample, other)).toBe(false);
  });
});

describe('validateAnchor (strict)', () => {
  it('accepts a well-formed anchor', () => {
    expect(validateAnchor(sample)).toEqual(sample);
  });

  it('accepts an anchor without title', () => {
    const { title: _omit, ...rest } = sample;
    expect(validateAnchor(rest)).toEqual(rest);
  });

  it('rejects unknown type', () => {
    expect(() => validateAnchor({ ...sample, type: 'task' })).toThrow(/invalid type/i);
  });

  it('rejects empty id', () => {
    expect(() => validateAnchor({ ...sample, id: '' })).toThrow(/id must be/i);
  });

  it('rejects non-string addedAt', () => {
    expect(() => validateAnchor({ ...sample, addedAt: 123 })).toThrow(/addedAt/i);
  });

  it('rejects unknown addedBy', () => {
    expect(() => validateAnchor({ ...sample, addedBy: 'system' })).toThrow(/addedBy/i);
  });

  it('rejects non-object input', () => {
    expect(() => validateAnchor(null)).toThrow(/object/i);
    expect(() => validateAnchor('feature:abc')).toThrow(/object/i);
  });
});

describe('validateAnchorsLenient', () => {
  it('returns empty array for nullish input', () => {
    expect(validateAnchorsLenient(undefined)).toEqual([]);
    expect(validateAnchorsLenient(null)).toEqual([]);
  });

  it('returns empty array for non-array input', () => {
    expect(validateAnchorsLenient({ type: 'feature' })).toEqual([]);
    expect(validateAnchorsLenient('feature')).toEqual([]);
  });

  it('passes through valid anchors', () => {
    expect(validateAnchorsLenient([sample])).toEqual([sample]);
  });

  it('drops invalid entries silently and keeps valid ones', () => {
    const mixed = [sample, { type: 'task', id: 'x' }, { ...sample, id: '' }, { ...sample, id: 'feat-2' }];
    const result = validateAnchorsLenient(mixed);
    expect(result.length).toBe(2);
    expect(result[0].id).toBe('feat-abc-123');
    expect(result[1].id).toBe('feat-2');
  });
});

describe('session persistence: anchors', () => {
  it('includes anchors in SESSION_PERSISTENT_FIELDS', () => {
    expect(SESSION_PERSISTENT_FIELDS).toContain('anchors');
  });

  it('pickSessionFields preserves anchors when present', () => {
    const source = {
      id: 's1',
      workspaceRootPath: '/tmp/ws',
      createdAt: 1,
      lastUsedAt: 2,
      anchors: [sample],
      runtimeOnly: 'should be dropped',
    } as const;

    const picked = pickSessionFields(source);
    expect(picked.anchors).toEqual([sample]);
    expect((picked as Record<string, unknown>).runtimeOnly).toBeUndefined();
  });

  it('pickSessionFields handles missing anchors gracefully', () => {
    const source = {
      id: 's1',
      workspaceRootPath: '/tmp/ws',
      createdAt: 1,
      lastUsedAt: 2,
    };
    const picked = pickSessionFields(source);
    expect(picked.anchors).toBeUndefined();
  });
});
