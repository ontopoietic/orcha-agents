import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { PromptBuilder } from '../prompt-builder.ts';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PromptBuilderConfig, ContextBlockOptions } from '../types.ts';

// ============================================================================
// Test fixtures
// ============================================================================

const TEST_DIR = join(import.meta.dir, '__test_observations_prompt__');
const TEST_WORKSPACE = join(TEST_DIR, 'workspace');
const TEST_SESSIONS = join(TEST_WORKSPACE, 'sessions');
const SESSION_ID = 'test-session-obs';
const SESSION_DIR = join(TEST_SESSIONS, SESSION_ID);
const OBSERVATIONS_FILE = join(SESSION_DIR, 'data', 'observations.json');

function makeConfig(): PromptBuilderConfig {
  return {
    workspace: { rootPath: TEST_WORKSPACE, id: 'test-ws' } as any,
    session: { id: SESSION_ID, workspaceRootPath: TEST_WORKSPACE } as any,
  };
}

function makeContextOptions(): ContextBlockOptions {
  return {
    permissionMode: 'allow-all',
    plansFolderPath: join(SESSION_DIR, 'plans'),
    dataFolderPath: join(SESSION_DIR, 'data'),
  };
}

function writeObservations(signals: Array<{ summary: string; salience: string; createdAt: string }>): void {
  mkdirSync(join(SESSION_DIR, 'data'), { recursive: true });
  writeFileSync(OBSERVATIONS_FILE, JSON.stringify({ signals }) + '\n', 'utf-8');
}

/**
 * Write a fake session.jsonl with `messageCount + 1` lines (header + N messages).
 * The injection length-gate uses this line count to decide whether to inject.
 * Default `messageCount` (40) clears the gate (default threshold = 20 lines).
 */
function writeSessionJsonl(messageCount = 40, anchors: Array<{ type: string; id: string }> = []): void {
  const header = { id: SESSION_ID, anchors };
  const lines = [JSON.stringify(header)];
  for (let i = 0; i < messageCount; i++) {
    lines.push(JSON.stringify({ id: `msg-${i}`, type: i % 2 === 0 ? 'user' : 'assistant', content: 'x' }));
  }
  writeFileSync(join(SESSION_DIR, 'session.jsonl'), lines.join('\n') + '\n', 'utf-8');
}

const sampleSignals = [
  { id: 'sig-1', summary: '🔴 USER STATED: Project uses pnpm', salience: 'pivotal', createdAt: '2026-05-07T10:00:00Z', source: 'conversation' },
  { id: 'sig-2', summary: '🔴 USER STATED: Always work on feature branches', salience: 'pivotal', createdAt: '2026-05-07T10:05:00Z', source: 'conversation' },
  { id: 'sig-3', summary: '🟡 USER ASKED: Should we use D1 or Turso?', salience: 'question', createdAt: '2026-05-07T10:10:00Z', source: 'conversation' },
  { id: 'sig-4', summary: '🟢 OBSERVED: Anchor set to feature/modul-system', salience: 'context', createdAt: '2026-05-07T10:15:00Z', source: 'conversation' },
  { id: 'sig-5', summary: '🟢 OBSERVED: Agent modified schema types', salience: 'context', createdAt: '2026-05-07T10:20:00Z', source: 'conversation' },
];

// ============================================================================
// Tests
// ============================================================================

describe('getSessionObservations', () => {
  let builder: PromptBuilder;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(SESSION_DIR, { recursive: true });
    builder = new PromptBuilder(makeConfig());
    // Default: long-enough session so the length-gate doesn't block tests.
    // Tests that want to exercise the gate write their own jsonl.
    writeSessionJsonl();
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('returns null when no observations file exists', () => {
    expect(builder.getSessionObservations(SESSION_ID)).toBeNull();
  });

  it('returns null for empty signals array', () => {
    writeObservations([]);
    expect(builder.getSessionObservations(SESSION_ID)).toBeNull();
  });

  it('skips injection when conversation is below the length threshold', () => {
    // Overwrite the jsonl with a short one
    writeSessionJsonl(5);
    writeObservations(sampleSignals);
    expect(builder.getSessionObservations(SESSION_ID)).toBeNull();
  });

  it('filters observations by anchor scope when session has anchors', () => {
    writeSessionJsonl(40, [{ type: 'feature', id: 'feat-A' }]);
    writeObservations([
      // Matching anchor → included
      { id: 's1', summary: 'IN', salience: 'pivotal', createdAt: '2026-05-07T10:00:00Z', source: 'conversation', anchorRefs: [{ type: 'feature', id: 'feat-A' }] } as any,
      // Different anchor → excluded
      { id: 's2', summary: 'OUT', salience: 'pivotal', createdAt: '2026-05-07T10:01:00Z', source: 'conversation', anchorRefs: [{ type: 'feature', id: 'feat-B' }] } as any,
      // Anchor-less → included (treated as session-local)
      { id: 's3', summary: 'BARE', salience: 'pivotal', createdAt: '2026-05-07T10:02:00Z', source: 'conversation' } as any,
    ]);
    const result = builder.getSessionObservations(SESSION_ID);
    expect(result).not.toBeNull();
    expect(result!).toContain('IN');
    expect(result!).toContain('BARE');
    expect(result!).not.toContain('OUT');
    expect(result!).toContain('scoped to 1 anchor');
  });

  it('shows all observations when session has no anchors', () => {
    // jsonl already has anchors:[] from beforeEach
    writeObservations([
      { id: 's1', summary: 'A', salience: 'pivotal', createdAt: '2026-05-07T10:00:00Z', source: 'conversation', anchorRefs: [{ type: 'feature', id: 'feat-A' }] } as any,
      { id: 's2', summary: 'B', salience: 'pivotal', createdAt: '2026-05-07T10:01:00Z', source: 'conversation', anchorRefs: [{ type: 'feature', id: 'feat-B' }] } as any,
    ]);
    const result = builder.getSessionObservations(SESSION_ID);
    expect(result).not.toBeNull();
    expect(result!).toContain('A');
    expect(result!).toContain('B');
  });

  it('returns formatted block for valid observations', () => {
    writeObservations(sampleSignals);
    const result = builder.getSessionObservations(SESSION_ID);

    expect(result).not.toBeNull();
    expect(result!).toContain('<session_memory>');
    expect(result!).toContain('</session_memory>');
    expect(result!).toContain('🔴 USER STATED: Project uses pnpm');
    expect(result!).toContain('🟡 USER ASKED: Should we use D1 or Turso?');
    expect(result!).toContain('🟢 OBSERVED: Anchor set to feature/modul-system');
    expect(result!).toContain('5 observations total, 5 in scope, showing 5');
  });

  it('sorts pivotal before question before context', () => {
    // Write in reverse order
    const reversed = [...sampleSignals].reverse();
    writeObservations(reversed);
    const result = builder.getSessionObservations(SESSION_ID);

    expect(result).not.toBeNull();
    const lines = result!.split('\n').filter(l => l.startsWith('🔴') || l.startsWith('🟡') || l.startsWith('🟢'));

    // Pivotal should come first
    expect(lines[0]).toContain('🔴');
    expect(lines[1]).toContain('🔴');
    expect(lines[2]).toContain('🟡');
    expect(lines[3]).toContain('🟢');
  });

  it('truncates when observations exceed max chars', () => {
    // Create observations with long summaries to hit the char limit
    const longSignals = Array.from({ length: 100 }, (_, i) => ({
      summary: `🟢 OBSERVED: ${'x'.repeat(100)} observation ${i}`,
      salience: 'context',
      createdAt: new Date(Date.now() + i * 1000).toISOString(),
    }));
    writeObservations(longSignals);

    const result = builder.getSessionObservations(SESSION_ID);
    expect(result).not.toBeNull();
    // Should be truncated but still contain the block
    expect(result!.length).toBeLessThan(4000);
  });

  it('limits to max 50 observations', () => {
    const manySignals = Array.from({ length: 60 }, (_, i) => ({
      summary: `🔴 USER STATED: Decision ${i}`,
      salience: 'pivotal' as const,
      createdAt: new Date(Date.now() + i * 1000).toISOString(),
    }));
    writeObservations(manySignals);

    const result = builder.getSessionObservations(SESSION_ID);
    expect(result).not.toBeNull();
    expect(result!).toContain('60 observations total, 60 in scope, showing 50');
  });

  it('handles corrupted JSON gracefully', () => {
    mkdirSync(join(SESSION_DIR, 'data'), { recursive: true });
    writeFileSync(OBSERVATIONS_FILE, 'NOT JSON{{{', 'utf-8');
    expect(builder.getSessionObservations(SESSION_ID)).toBeNull();
  });
});

describe('buildContextParts with observations', () => {
  let builder: PromptBuilder;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(SESSION_DIR, { recursive: true });
    builder = new PromptBuilder(makeConfig());
    writeSessionJsonl();
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('includes observations in context parts when they exist', () => {
    writeObservations(sampleSignals);
    const parts = builder.buildContextParts(makeContextOptions());

    const joined = parts.join('\n');
    expect(joined).toContain('<session_memory>');
    expect(joined).toContain('🔴 USER STATED');
  });

  it('does not include session_memory block when no observations', () => {
    // No observations file → no block
    const parts = builder.buildContextParts(makeContextOptions());

    const joined = parts.join('\n');
    expect(joined).not.toContain('<session_memory>');
  });

  it('still includes all other context parts alongside observations', () => {
    writeObservations(sampleSignals);
    const parts = builder.buildContextParts(makeContextOptions());

    // Should have date/time, session state, workspace capabilities, working dir, observations
    expect(parts.length).toBeGreaterThanOrEqual(4);

    const joined = parts.join('\n');
    // Date/time context
    expect(joined).toContain("USER'S DATE AND TIME");
    // Workspace capabilities
    expect(joined).toContain('<workspace_capabilities>');
    // Session memory
    expect(joined).toContain('<session_memory>');
  });
});
