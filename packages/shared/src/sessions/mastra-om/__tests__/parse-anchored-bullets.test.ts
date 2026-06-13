import { describe, expect, it } from 'bun:test';
import { parseAnchoredBullets } from '../parse-anchored-bullets.ts';

describe('parseAnchoredBullets', () => {
  it('returns empty array for empty input', () => {
    expect(parseAnchoredBullets('')).toEqual([]);
  });

  it('parses a single bullet with anchor', () => {
    const input = `Date: May 21, 2026
* 🔴 (14:30) User chose feature-branch workflow {abc123}`;
    const bullets = parseAnchoredBullets(input);
    expect(bullets).toHaveLength(1);
    const first = bullets[0]!;
    expect(first.salience).toBe('pivotal');
    expect(first.time).toBe('14:30');
    expect(first.summary).toBe('User chose feature-branch workflow');
    expect(first.anchorShortId).toBe('abc123');
    expect(first.dateHeader).toBe('May 21, 2026');
  });

  it('captures sub-bullets under the parent', () => {
    const input = `* 🔴 (14:30) Decision X {abc123}
  * -> rationale A
  * -> implication B`;
    const bullets = parseAnchoredBullets(input);
    expect(bullets).toHaveLength(1);
    const first = bullets[0]!;
    expect(first.subBullets).toHaveLength(2);
    expect(first.subBullets[0]).toContain('rationale A');
  });

  it('handles all four salience emojis', () => {
    const input = `* 🔴 (10:00) pivotal {a11111}
* 🟡 (10:01) question {b22222}
* 🟢 (10:02) context {c33333}
* ✅ (10:03) completion {d44444}`;
    const bullets = parseAnchoredBullets(input);
    // 🟡 Medium maps to 'context' (contextual facts, not questions) — see
    // SALIENCE_FROM_EMOJI rationale in parse-anchored-bullets.ts.
    expect(bullets.map((b) => b.salience)).toEqual([
      'pivotal',
      'context',
      'context',
      'completion',
    ]);
    expect(bullets.map((b) => b.anchorShortId)).toEqual([
      'a11111',
      'b22222',
      'c33333',
      'd44444',
    ]);
  });

  it('marks bullets without anchor as null', () => {
    const input = `* 🔴 (14:30) Decision without anchor`;
    const bullets = parseAnchoredBullets(input);
    expect(bullets).toHaveLength(1);
    expect(bullets[0]!.anchorShortId).toBeNull();
  });

  it('tolerates missing time prefix', () => {
    const input = `* 🟢 just a context bullet {anchorx}`;
    const bullets = parseAnchoredBullets(input);
    expect(bullets[0]!.time).toBeNull();
    expect(bullets[0]!.summary).toBe('just a context bullet');
    expect(bullets[0]!.anchorShortId).toBe('anchorx');
  });

  it('groups bullets by date headers', () => {
    const input = `Date: May 18, 2026
* 🔴 (09:00) old fact {old001}

Date: May 21, 2026
* 🔴 (14:30) new fact {new001}`;
    const bullets = parseAnchoredBullets(input);
    expect(bullets).toHaveLength(2);
    expect(bullets[0]!.dateHeader).toBe('May 18, 2026');
    expect(bullets[1]!.dateHeader).toBe('May 21, 2026');
  });

  it('also accepts orcha-style # YYYY-MM-DD headers', () => {
    const input = `# 2026-05-21
- 🔴 14:30 orcha-style bullet {anchor}`;
    const bullets = parseAnchoredBullets(input);
    expect(bullets).toHaveLength(1);
    expect(bullets[0]!.dateHeader).toBe('2026-05-21');
  });

  it('ignores stray prose lines between bullets', () => {
    const input = `Some intro prose
* 🔴 (14:30) Bullet one {anchor1}
random stray text
* 🟡 (14:31) Bullet two {anchor2}
trailing junk`;
    const bullets = parseAnchoredBullets(input);
    expect(bullets).toHaveLength(2);
    expect(bullets[0]!.anchorShortId).toBe('anchor1');
    expect(bullets[1]!.anchorShortId).toBe('anchor2');
  });
});
