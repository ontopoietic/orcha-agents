import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { PromptBuilder } from '../prompt-builder.ts';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PromptBuilderConfig, ContextBlockOptions } from '../types.ts';

// ============================================================================
// Test fixtures — post Plan A: observations.md is the canonical source.
// ============================================================================

const TEST_DIR = join(import.meta.dir, '__test_observations_prompt__');
const TEST_WORKSPACE = join(TEST_DIR, 'workspace');
const TEST_SESSIONS = join(TEST_WORKSPACE, 'sessions');
const SESSION_ID = 'test-session-obs';
const SESSION_DIR = join(TEST_SESSIONS, SESSION_ID);
const OBSERVATIONS_MD = join(SESSION_DIR, 'data', 'observations.md');
const EVIDENCE_FILE = join(SESSION_DIR, 'data', 'observations-evidence.json');

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

function writeObservationsMd(content: string): void {
  mkdirSync(join(SESSION_DIR, 'data'), { recursive: true });
  writeFileSync(OBSERVATIONS_MD, content, 'utf-8');
}

function writeEvidence(entries: Record<string, { anchorRefs?: Array<{ type: string; id: string }> }>): void {
  mkdirSync(join(SESSION_DIR, 'data'), { recursive: true });
  writeFileSync(EVIDENCE_FILE, JSON.stringify(entries, null, 2) + '\n', 'utf-8');
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

const sampleMarkdown = `# 2026-05-07
- 🔴 10:00 Project uses pnpm {abc111}
- 🔴 10:05 Always work on feature branches {abc222}
- 🟡 10:10 Open question: D1 vs. Turso? {abc333}
- 🟢 10:15 Anchor set to feature/modul-system {abc444}
- 🟢 10:20 Agent modified schema types {abc555}
`;

// ============================================================================
// getSessionObservations
// ============================================================================

describe('getSessionObservations (Markdown path)', () => {
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

  it('returns null when observations.md does not exist', () => {
    expect(builder.getSessionObservations(SESSION_ID)).toBeNull();
  });

  it('returns null for an empty markdown file', () => {
    writeObservationsMd('');
    expect(builder.getSessionObservations(SESSION_ID)).toBeNull();
  });

  it('skips injection when conversation is below the length threshold', () => {
    writeSessionJsonl(5);
    writeObservationsMd(sampleMarkdown);
    expect(builder.getSessionObservations(SESSION_ID)).toBeNull();
  });

  it('returns a formatted <session_memory> block with stripped anchors', () => {
    writeObservationsMd(sampleMarkdown);
    const result = builder.getSessionObservations(SESSION_ID);

    expect(result).not.toBeNull();
    expect(result!).toContain('<session_memory>');
    expect(result!).toContain('</session_memory>');
    // Summaries land in the block
    expect(result!).toContain('Project uses pnpm');
    expect(result!).toContain('Open question: D1 vs. Turso?');
    // Anchor short-IDs are stripped before injection (UI sidecar holds them)
    expect(result!).not.toContain('{abc111}');
    expect(result!).not.toContain('{abc333}');
    // Stats line surfaces the bullet count
    expect(result!).toContain('5 observations');
  });

  it('preserves file order (date headers + bullet order)', () => {
    writeObservationsMd(sampleMarkdown);
    const result = builder.getSessionObservations(SESSION_ID)!;
    // Pnpm bullet appears before the D1/Turso question in the file
    const idxA = result.indexOf('Project uses pnpm');
    const idxB = result.indexOf('D1 vs. Turso');
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(idxA);
  });

  it('caps total chars and emits a truncation marker', () => {
    // Build a markdown payload well over MAX_OBSERVATIONS_CHARS (3000)
    const longBullets = Array.from({ length: 200 }, (_, i) =>
      `- 🟢 10:${String(i % 60).padStart(2, '0')} ${'x'.repeat(80)} observation ${i}`,
    ).join('\n');
    writeObservationsMd(`# 2026-05-07\n${longBullets}\n`);

    const result = builder.getSessionObservations(SESSION_ID);
    expect(result).not.toBeNull();
    expect(result!).toContain('(truncated)');
    // Body part itself should not blow past the char cap by much
    expect(result!.length).toBeLessThan(5000);
  });

  it('returns null gracefully when markdown has no bullets', () => {
    writeObservationsMd('# 2026-05-07\n\nsome prose but no bullets\n');
    expect(builder.getSessionObservations(SESSION_ID)).toBeNull();
  });

  describe('anchor-scope filter', () => {
    it('filters observations by session anchors using evidence sidecar', () => {
      writeSessionJsonl(40, [{ type: 'feature', id: 'feat-A' }]);
      writeObservationsMd(
        '# 2026-05-07\n' +
        '- 🔴 10:00 IN-A {aaa111}\n' +    // matches feat-A → keep
        '- 🔴 10:05 OUT-B {bbb222}\n' +   // matches feat-B → drop
        '- 🔴 10:10 BARE-NO-SIDECAR {ccc333}\n' + // no sidecar entry → keep (session-local)
        '- 🔴 10:15 BARE-NO-REFS {ddd444}\n' +    // sidecar but empty anchorRefs → keep
        '- 🔴 10:20 ANCHORLESS\n',                // no anchor at all → keep
      );
      writeEvidence({
        aaa111: { anchorRefs: [{ type: 'feature', id: 'feat-A' }] },
        bbb222: { anchorRefs: [{ type: 'feature', id: 'feat-B' }] },
        ddd444: { anchorRefs: [] },
      });

      const result = builder.getSessionObservations(SESSION_ID);
      expect(result).not.toBeNull();
      expect(result!).toContain('IN-A');
      expect(result!).toContain('BARE-NO-SIDECAR');
      expect(result!).toContain('BARE-NO-REFS');
      expect(result!).toContain('ANCHORLESS');
      expect(result!).not.toContain('OUT-B');
      expect(result!).toContain('5 observations total, 4 in scope, showing 4');
      expect(result!).toContain('scoped to 1 anchor');
    });

    it('shows all observations when session has no anchors', () => {
      writeSessionJsonl(40, []);
      writeObservationsMd(
        '# 2026-05-07\n' +
        '- 🔴 10:00 A {aaa111}\n' +
        '- 🔴 10:05 B {bbb222}\n',
      );
      writeEvidence({
        aaa111: { anchorRefs: [{ type: 'feature', id: 'feat-A' }] },
        bbb222: { anchorRefs: [{ type: 'feature', id: 'feat-B' }] },
      });

      const result = builder.getSessionObservations(SESSION_ID);
      expect(result).not.toBeNull();
      expect(result!).toContain('A');
      expect(result!).toContain('B');
      // No scope-stats when session is unscoped
      expect(result!).not.toContain('scoped to');
    });

    it('returns null when every bullet is filtered out', () => {
      writeSessionJsonl(40, [{ type: 'feature', id: 'feat-A' }]);
      writeObservationsMd('# 2026-05-07\n- 🔴 10:00 X {bbb222}\n');
      writeEvidence({ bbb222: { anchorRefs: [{ type: 'feature', id: 'feat-B' }] } });

      expect(builder.getSessionObservations(SESSION_ID)).toBeNull();
    });
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
    writeObservationsMd(sampleMarkdown);
    const parts = builder.buildContextParts(makeContextOptions());

    const joined = parts.join('\n');
    expect(joined).toContain('<session_memory>');
    expect(joined).toContain('Project uses pnpm');
  });

  it('does not include session_memory block when no observations', () => {
    const parts = builder.buildContextParts(makeContextOptions());

    const joined = parts.join('\n');
    expect(joined).not.toContain('<session_memory>');
  });

  it('still includes all other context parts alongside observations', () => {
    writeObservationsMd(sampleMarkdown);
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
