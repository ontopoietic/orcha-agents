import { describe, expect, it } from 'bun:test';
import {
  parseObservationsMarkdown,
  resolveAnchorShortId,
  type ParsedBullet,
} from '../observation-markdown-parser.ts';

function parseStrict(md: string): ParsedBullet[] {
  const out = parseObservationsMarkdown(md);
  if (!out) throw new Error('parser returned null');
  return out;
}

describe('parseObservationsMarkdown', () => {
  it('parses a basic single-date block with three salience levels', () => {
    const md = `# 2026-05-09
- 🔴 14:49 User chose Rahmen-Graph as next work item {u5luxw}
- 🟡 15:10 Open question: glow uniform or per-tension? {aaa001}
- 🟢 15:20 Edges need new visual treatment {ddd002}`;
    const bullets = parseStrict(md);
    expect(bullets).toHaveLength(3);
    expect(bullets[0]).toMatchObject({
      salience: 'high',
      time: '14:49',
      summary: 'User chose Rahmen-Graph as next work item',
      anchorShortId: 'u5luxw',
      date: '2026-05-09',
    });
    expect(bullets[1]?.salience).toBe('medium');
    expect(bullets[2]?.salience).toBe('low');
  });

  it('returns null when input contains no bullets', () => {
    expect(parseObservationsMarkdown('# 2026-05-09\n\nNo bullets here.')).toBeNull();
    expect(parseObservationsMarkdown('')).toBeNull();
    expect(parseObservationsMarkdown('just prose')).toBeNull();
  });

  it('strips defensive code fences', () => {
    const fenced = '```markdown\n# 2026-05-09\n- 🔴 14:49 A decision {abc123}\n```';
    const bullets = parseStrict(fenced);
    expect(bullets).toHaveLength(1);
    expect(bullets[0]?.summary).toBe('A decision');
  });

  it('appends sub-bullets onto the preceding top-level bullet', () => {
    const md = `# 2026-05-09
- 🔴 14:49 Architecture change {u5luxw}
  - Resolution now only indirect via contextualized options
- 🟡 15:10 Next question {aaa001}`;
    const bullets = parseStrict(md);
    expect(bullets).toHaveLength(2);
    expect(bullets[0]?.summary).toBe(
      'Architecture change — Resolution now only indirect via contextualized options',
    );
    expect(bullets[1]?.summary).toBe('Next question');
  });

  it('accepts bullets without anchors', () => {
    const md = `# 2026-05-09
- 🔴 14:49 A decision without an anchor`;
    const bullets = parseStrict(md);
    expect(bullets).toHaveLength(1);
    expect(bullets[0]?.anchorShortId).toBeNull();
  });

  it('handles multiple date headers in order', () => {
    const md = `# 2026-05-11
- 🔴 09:00 Today's first decision {today1}

# 2026-05-09
- 🟢 14:49 Earlier context {past01}`;
    const bullets = parseStrict(md);
    expect(bullets).toHaveLength(2);
    expect(bullets[0]?.date).toBe('2026-05-11');
    expect(bullets[1]?.date).toBe('2026-05-09');
  });
});

describe('resolveAnchorShortId', () => {
  const candidates = [
    { id: 'msg-1778338128969-u5luxw' },
    { id: 'msg-1778339000000-aaa001' },
    { id: 'short-id' },
  ];

  it('matches the standard msg-{epoch}-{short} pattern', () => {
    expect(resolveAnchorShortId('u5luxw', candidates)?.id).toBe('msg-1778338128969-u5luxw');
    expect(resolveAnchorShortId('aaa001', candidates)?.id).toBe('msg-1778339000000-aaa001');
  });

  it('matches case-insensitively', () => {
    expect(resolveAnchorShortId('U5LUXW', candidates)?.id).toBe('msg-1778338128969-u5luxw');
  });

  it('returns null when no candidate matches', () => {
    expect(resolveAnchorShortId('zzzzzz', candidates)).toBeNull();
    expect(resolveAnchorShortId('', candidates)).toBeNull();
  });

  it('falls back to last-N-chars match when no dashes match exactly', () => {
    expect(resolveAnchorShortId('ort-id', [{ id: 'short-id' }])?.id).toBe('short-id');
  });
});
