import { describe, expect, it } from 'bun:test';
import {
  extractArtifactsFromMessages,
  parseAnchorsInput,
  parseOrchaCliInvocations,
  type ExtractorJsonlMessage,
} from '../episode-extractors.ts';

describe('parseAnchorsInput', () => {
  it('returns [] for non-array, non-string input', () => {
    expect(parseAnchorsInput(undefined)).toEqual([]);
    expect(parseAnchorsInput(null)).toEqual([]);
    expect(parseAnchorsInput(42)).toEqual([]);
  });

  it('parses an array of anchor objects', () => {
    const out = parseAnchorsInput([
      { type: 'feature', id: 'f1', label: 'My Feature' },
      { type: 'befund', id: 'b1', title: 'Something noticed' },
    ]);
    expect(out).toEqual([
      { type: 'feature', ref: 'f1', label: 'My Feature' },
      { type: 'befund', ref: 'b1', label: 'Something noticed' },
    ]);
  });

  it('parses a stringified JSON array (the legacy MCP shape)', () => {
    const raw = JSON.stringify([{ type: 'anliegen', id: 'a1', label: 'X' }]);
    const out = parseAnchorsInput(raw);
    expect(out.length).toBe(1);
    expect(out[0]!.type).toBe('anliegen');
    expect(out[0]!.ref).toBe('a1');
  });

  it('coerces unknown anchor types to "other"', () => {
    const out = parseAnchorsInput([{ type: 'mystery-type', id: 'm1' }]);
    expect(out).toEqual([{ type: 'other', ref: 'm1' }]);
  });

  it('drops entries missing type or id', () => {
    const out = parseAnchorsInput([
      { type: 'feature' },
      { id: 'x' },
      { type: 'feature', id: 'good', label: 'L' },
    ]);
    expect(out.length).toBe(1);
    expect(out[0]!.ref).toBe('good');
  });

  it('survives a corrupted JSON string by returning []', () => {
    expect(parseAnchorsInput('{not json')).toEqual([]);
  });
});

describe('parseOrchaCliInvocations', () => {
  it('parses a simple orcha tradeoff create call', () => {
    const out = parseOrchaCliInvocations(
      'orcha tradeoff create --name "Performance ↔ Lesbarkeit" --type technical',
    );
    expect(out.length).toBe(1);
    expect(out[0]!.type).toBe('other');
    expect(out[0]!.label).toBe('tradeoff: Performance ↔ Lesbarkeit');
  });

  it('parses multi-line and ;-chained commands independently', () => {
    const cmd = 'orcha feature add --name foo\norcha tradeoff create --name bar; echo done';
    const out = parseOrchaCliInvocations(cmd);
    expect(out.length).toBe(2);
    expect(out[0]!.label).toContain('feature: foo');
    expect(out[1]!.label).toContain('tradeoff: bar');
  });

  it('skips read-only verbs (list, get)', () => {
    expect(parseOrchaCliInvocations('orcha tradeoff list')).toEqual([]);
    expect(parseOrchaCliInvocations('orcha feature get abc-123')).toEqual([]);
  });

  it('skips unknown subcommand types', () => {
    expect(parseOrchaCliInvocations('orcha unicorn create --name x')).toEqual([]);
  });

  it('handles "cd ... && orcha ..." prefix', () => {
    const out = parseOrchaCliInvocations('cd ~/proj && orcha task add --name "fix bug"');
    expect(out.length).toBe(1);
    expect(out[0]!.label).toBe('task: fix bug');
  });

  it('falls back to label "<type> (<verb>)" when no name visible', () => {
    const out = parseOrchaCliInvocations('orcha decision update');
    expect(out.length).toBe(1);
    expect(out[0]!.label).toBe('decision (update)');
  });
});

describe('extractArtifactsFromMessages', () => {
  function tool(name: string, input: Record<string, unknown>): ExtractorJsonlMessage {
    return { id: `m-${Math.random()}`, type: 'tool', toolName: name, toolInput: input };
  }

  it('extracts file paths from Edit/Write/Read/NotebookEdit (deduplicated)', () => {
    const out = extractArtifactsFromMessages([
      tool('Edit', { file_path: '/a.ts' }),
      tool('Read', { file_path: '/a.ts' }), // dup
      tool('Write', { file_path: '/b.ts' }),
      tool('NotebookEdit', { notebook_path: '/c.ipynb' }),
    ]);
    expect(out.map((a) => a.ref).sort()).toEqual(['/a.ts', '/b.ts', '/c.ipynb']);
  });

  it('extracts plan paths from SubmitPlan', () => {
    const out = extractArtifactsFromMessages([
      tool('mcp__session__SubmitPlan', { planPath: '/p.md' }),
    ]);
    expect(out).toEqual([{ type: 'plan', ref: '/p.md' }]);
  });

  it('extracts anchors from set_session_anchors with array input', () => {
    const out = extractArtifactsFromMessages([
      tool('mcp__session__set_session_anchors', {
        anchors: [{ type: 'feature', id: 'f1', label: 'X' }],
      }),
    ]);
    expect(out).toEqual([{ type: 'feature', ref: 'f1', label: 'X' }]);
  });

  it('extracts anchors from set_session_anchors with stringified input (legacy)', () => {
    const out = extractArtifactsFromMessages([
      tool('mcp__session__set_session_anchors', {
        anchors: JSON.stringify([{ type: 'feature', id: 'f1' }]),
      }),
    ]);
    expect(out.length).toBe(1);
    expect(out[0]!.ref).toBe('f1');
  });

  it('dedupes anchor across re-affirmations within the phase', () => {
    const out = extractArtifactsFromMessages([
      tool('mcp__session__set_session_anchors', { anchors: [{ type: 'feature', id: 'f1' }] }),
      tool('mcp__session__set_session_anchors', { anchors: [{ type: 'feature', id: 'f1' }] }),
    ]);
    expect(out.length).toBe(1);
  });

  it('extracts orcha CLI invocations from Bash tool calls', () => {
    const out = extractArtifactsFromMessages([
      tool('Bash', { command: 'orcha tradeoff create --name "A ↔ B"' }),
    ]);
    expect(out.length).toBe(1);
    expect(out[0]!.label).toBe('tradeoff: A ↔ B');
  });

  it('skips non-tool messages', () => {
    const out = extractArtifactsFromMessages([
      { id: 'u1', type: 'user' },
      { id: 'a1', type: 'assistant' },
    ]);
    expect(out).toEqual([]);
  });
});
