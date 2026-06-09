import { describe, expect, it } from 'bun:test';
import {
  detectDegenerateRepetition,
  extractCurrentTask,
  hasCurrentTaskSection,
  parseObserverOutput,
  parseReflectorOutput,
  sanitizeObservationLines,
  stripEphemeralAnchorIds,
  stripObservationGroups,
} from '../parsers.ts';

describe('parseObserverOutput', () => {
  it('parses the canonical Mastra Observer output shape', () => {
    const raw = `<observations>
Date: Dec 4, 2025
* 🔴 (14:30) User prefers direct answers
* 🔴 (14:31) Working on feature X
* 🟡 (14:32) User might prefer dark mode

Date: Dec 5, 2025
* 🔴 (09:15) Continued work on feature X
</observations>

<current-task>
Implement dark mode toggle
</current-task>

<suggested-response>
I've added the toggle — want me to walk through the changes?
</suggested-response>`;
    const out = parseObserverOutput(raw);
    expect(out.degenerate).toBeUndefined();
    expect(out.observations).toContain('Date: Dec 4, 2025');
    expect(out.observations).toContain('🔴 (14:30) User prefers direct answers');
    expect(out.observations).toContain('Date: Dec 5, 2025');
    expect(out.currentTask).toBe('Implement dark mode toggle');
    expect(out.suggestedContinuation).toBe(
      "I've added the toggle — want me to walk through the changes?",
    );
    expect(out.threadTitle).toBeUndefined();
  });

  it('falls back to list-item extraction when <observations> wrapper missing', () => {
    const raw = `Date: Dec 4, 2025
* 🔴 (14:30) User mentioned cats
- 🟡 (14:31) Tool call: viewFile`;
    const out = parseObserverOutput(raw);
    expect(out.observations).toContain('🔴 (14:30) User mentioned cats');
    expect(out.observations).toContain('🟡 (14:31) Tool call: viewFile');
  });

  it('captures <thread-title> when present', () => {
    const raw = `<observations>
Date: Dec 4, 2025
* 🔴 (14:30) Hi
</observations>
<thread-title>Auth bug fix</thread-title>`;
    const out = parseObserverOutput(raw);
    expect(out.threadTitle).toBe('Auth bug fix');
  });

  it('flags degenerate repetition', () => {
    const loop = ('Date: Dec 4, 2025\n* 🔴 (14:30) Repeating thing\n'.repeat(150));
    const out = parseObserverOutput(loop);
    expect(out.degenerate).toBe(true);
    expect(out.observations).toBe('');
  });

  // (Per-line truncation is exercised directly via sanitizeObservationLines
  //  below; parseObserverOutput intentionally short-circuits via
  //  detectDegenerateRepetition when a single huge line would dominate.)
});

describe('parseReflectorOutput', () => {
  it('parses condensed observations and ignores omitted continuation hints', () => {
    const raw = `<observations>
Date: Dec 4, 2025
* 🔴 (14:30) Consolidated: user prefers direct answers AND dark mode
* ✅ (14:45) Auth flow refactor completed
</observations>`;
    const out = parseReflectorOutput(raw);
    expect(out.degenerate).toBeUndefined();
    expect(out.observations).toContain('Consolidated: user prefers');
    expect(out.observations).toContain('✅ (14:45)');
    expect(out.suggestedContinuation).toBeUndefined();
  });

  it('strips line-leading ephemeral [O1]/[O1-N2] anchors injected for retrieval mode', () => {
    // Mastra injects retrieval-mode anchors as line-leading IDs (Mastra's
    // regex anchors on (^|\n) + leading whitespace); mid-line bracket text
    // is preserved verbatim because users may have legitimate bracket
    // content inside observations.
    const raw = `<observations>
[O1] User said something
  [O1-N2] sub-detail
</observations>`;
    const out = parseReflectorOutput(raw);
    expect(out.observations).not.toContain('[O1]');
    expect(out.observations).not.toContain('[O1-N2]');
    expect(out.observations).toContain('User said something');
    expect(out.observations).toContain('sub-detail');
  });
});

describe('current-task helpers', () => {
  it('hasCurrentTaskSection recognises XML and markdown headings', () => {
    expect(hasCurrentTaskSection('<current-task>x</current-task>')).toBe(true);
    expect(hasCurrentTaskSection('## Current Task\nfoo')).toBe(true);
    expect(hasCurrentTaskSection('**Current Task:** foo')).toBe(true);
    expect(hasCurrentTaskSection('no task here')).toBe(false);
  });

  it('extractCurrentTask returns the body inside the XML tag', () => {
    expect(extractCurrentTask('<current-task>  ship it  </current-task>')).toBe('ship it');
    expect(extractCurrentTask('no task here')).toBeNull();
  });
});

describe('strippers', () => {
  it('stripObservationGroups removes the retrieval-mode wrappers', () => {
    const raw = `<observation-group range="msg-1:msg-9">
* 🔴 stuff
</observation-group>

* 🔴 standalone`;
    const out = stripObservationGroups(raw);
    expect(out).not.toContain('<observation-group');
    expect(out).toContain('* 🔴 stuff');
    expect(out).toContain('* 🔴 standalone');
  });

  it('stripEphemeralAnchorIds removes [O\\d]/[O\\d-N\\d] inline IDs', () => {
    expect(stripEphemeralAnchorIds('  [O3] foo')).toBe('  foo');
    expect(stripEphemeralAnchorIds('  [O3-N12] bar')).toBe('  bar');
    expect(stripEphemeralAnchorIds('[O3] foo\n  [O3-N1] bar')).toBe('foo\n  bar');
  });
});

describe('sanitizeObservationLines', () => {
  it('leaves short lines untouched', () => {
    const input = '* 🔴 (14:30) hi\n* 🔴 (14:31) bye';
    expect(sanitizeObservationLines(input)).toBe(input);
  });
  it('truncates lines above 10k chars with marker', () => {
    const long = 'x'.repeat(12_000);
    const out = sanitizeObservationLines(`* 🔴 ${long}`);
    expect(out).toContain('[truncated]');
    expect(out.length).toBeLessThan(long.length + 100);
  });
});

describe('detectDegenerateRepetition', () => {
  it('returns false for normal-sized varied text', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}: ${'lorem ipsum '.repeat(5)}`).join(
      '\n',
    );
    expect(detectDegenerateRepetition(text)).toBe(false);
  });
  it('returns true when a chunk repeats heavily', () => {
    const text = 'AAAAAAAAAA'.repeat(2_000);
    expect(detectDegenerateRepetition(text)).toBe(true);
  });
  it('returns true when a single line is gigantic', () => {
    const text = 'x'.repeat(60_000);
    expect(detectDegenerateRepetition(text)).toBe(true);
  });
});
