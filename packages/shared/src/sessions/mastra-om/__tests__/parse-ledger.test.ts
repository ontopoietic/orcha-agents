import { describe, expect, it } from 'bun:test';
import { parseMastraLedger } from '../parse-ledger.ts';

describe('parseMastraLedger', () => {
  it('parses date headers in both Mastra forms', () => {
    const a = parseMastraLedger('Date: Dec 4, 2025\n* 🔴 (14:30) hi');
    expect(a?.[0]?.date).toBe('2025-12-04');
    const b = parseMastraLedger('Dec 4, 2025:\n* 🔴 (14:30) hi');
    expect(b?.[0]?.date).toBe('2025-12-04');
  });

  it('parses bullets with all four salience emojis', () => {
    const md = `Date: Dec 4, 2025
* 🔴 (14:30) High thing
* 🟡 (14:31) Medium thing
* 🟢 (14:32) Low thing
* ✅ (14:33) Completed thing`;
    const out = parseMastraLedger(md)!;
    // 1:1 Mastra taxonomy — ✅ keeps 'high' salience plus the completed flag.
    expect(out.map((b) => b.salience)).toEqual(['high', 'medium', 'low', 'high']);
    expect(out.map((b) => b.completed)).toEqual([false, false, false, true]);
    expect(out.map((b) => b.time)).toEqual(['14:30', '14:31', '14:32', '14:33']);
  });

  it('accepts bullets without a time prefix (Mastra completion lines often omit it)', () => {
    const md = `Date: Dec 4, 2025
* ✅ Auth flow refactor completed`;
    const out = parseMastraLedger(md)!;
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ salience: 'high', completed: true, time: '' });
    expect(out[0]?.summary).toBe('Auth flow refactor completed');
  });

  it('folds sub-bullets into the parent summary with " — " separators', () => {
    const md = `Date: Dec 4, 2025
* 🔴 (14:30) Debugging auth issue
  * -> ran git status, found 3 modified files
  * -> viewed auth.ts:45-60
  * ✅ Tests passing`;
    const out = parseMastraLedger(md)!;
    expect(out).toHaveLength(1);
    expect(out[0]?.summary).toBe(
      'Debugging auth issue — ran git status, found 3 modified files — viewed auth.ts:45-60 — Tests passing',
    );
    // ✅ in a sub-bullet promotes the parent's completed flag.
    expect(out[0]?.completed).toBe(true);
  });

  it('handles multiple date sections and preserves bullet order within each', () => {
    const md = `Date: Dec 4, 2025
* 🔴 (14:30) one
* 🟡 (14:31) two

Date: Dec 5, 2025
* 🟢 (09:15) three`;
    const out = parseMastraLedger(md)!;
    expect(out.map((b) => `${b.date}/${b.time}/${b.summary}`)).toEqual([
      '2025-12-04/14:30/one',
      '2025-12-04/14:31/two',
      '2025-12-05/09:15/three',
    ]);
  });

  it('returns null for empty input or content with no recognizable bullets', () => {
    expect(parseMastraLedger('')).toBeNull();
    expect(parseMastraLedger('just some prose\nno bullets here')).toBeNull();
  });

  it('blank lines / unparseable lines reset the sub-bullet attach cursor', () => {
    const md = `Date: Dec 4, 2025
* 🔴 (14:30) parent A
random prose breaking the chain
  * -> this orphan sub-bullet should NOT attach to A

* 🟡 (14:31) parent B
  * -> attaches to B`;
    const out = parseMastraLedger(md)!;
    expect(out).toHaveLength(2);
    expect(out[0]?.summary).toBe('parent A');
    expect(out[1]?.summary).toBe('parent B — attaches to B');
  });

  it('caps the folded summary at 600 chars with an ellipsis', () => {
    const longDetail = 'x'.repeat(800);
    const md = `Date: Dec 4, 2025
* 🔴 (14:30) parent
  * -> ${longDetail}`;
    const out = parseMastraLedger(md)!;
    expect(out[0]?.summary.length).toBeLessThanOrEqual(600);
    expect(out[0]?.summary.endsWith('…')).toBe(true);
  });

  it('extracts trailing {shortId} anchor and strips it from the summary', () => {
    const md = `Date: May 21, 2026
* 🔴 (14:30) User chose feature-branch workflow {abc123}
* 🟡 (14:31) Open question on DB choice {def456}`;
    const out = parseMastraLedger(md)!;
    expect(out).toHaveLength(2);
    expect(out[0]?.anchorShortId).toBe('abc123');
    expect(out[0]?.summary).toBe('User chose feature-branch workflow');
    expect(out[1]?.anchorShortId).toBe('def456');
    expect(out[1]?.summary).toBe('Open question on DB choice');
  });

  it('returns anchorShortId: null when the bullet has no anchor', () => {
    const md = `Date: May 21, 2026
* 🔴 (14:30) Bullet without anchor`;
    const out = parseMastraLedger(md)!;
    expect(out[0]?.anchorShortId).toBeNull();
    expect(out[0]?.summary).toBe('Bullet without anchor');
  });
});
