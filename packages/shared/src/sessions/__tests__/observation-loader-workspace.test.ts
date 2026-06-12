import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkspaceObservationSignals } from '../observation-loader.ts';

describe('loadWorkspaceObservationSignals', () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'obs-workspace-'));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  const writeSessionLedger = (sessionId: string, mastraMd: string) => {
    const dataDir = join(workspaceRoot, 'sessions', sessionId, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'observations.mastra.md'), mastraMd, 'utf-8');
  };

  it('returns [] when the workspace has no sessions directory', () => {
    expect(loadWorkspaceObservationSignals(workspaceRoot)).toEqual([]);
  });

  it('merges observations from every session, tagged with their sessionId', () => {
    writeSessionLedger('session-a', 'Date: May 20, 2026\n* 🔴 (10:00) decision in A');
    writeSessionLedger('session-b', 'Date: May 22, 2026\n* 🟢 (11:00) note in B');

    const signals = loadWorkspaceObservationSignals(workspaceRoot);
    expect(signals).toHaveLength(2);
    const bySession = new Map(signals.map((s) => [s.conversation?.sessionId, s.summary]));
    expect(bySession.get('session-a')).toBe('decision in A');
    expect(bySession.get('session-b')).toBe('note in B');
  });

  it('sorts across sessions by createdAt ascending', () => {
    writeSessionLedger('newer', 'Date: May 22, 2026\n* 🟢 (11:00) later');
    writeSessionLedger('older', 'Date: May 20, 2026\n* 🟢 (10:00) earlier');

    const signals = loadWorkspaceObservationSignals(workspaceRoot);
    expect(signals.map((s) => s.summary)).toEqual(['earlier', 'later']);
  });

  it('does NOT dedupe identical signal IDs across sessions', () => {
    // Same anchor shortId in two sessions → two distinct signals; IDs are
    // only unique per session, consumers key on (sessionId, id).
    writeSessionLedger('s1', 'Date: May 20, 2026\n* 🔴 (10:00) first {abc123}');
    writeSessionLedger('s2', 'Date: May 21, 2026\n* 🔴 (10:00) second {abc123}');

    const signals = loadWorkspaceObservationSignals(workspaceRoot);
    expect(signals).toHaveLength(2);
    expect(signals[0]!.id).toBe(signals[1]!.id); // same per-session ID…
    expect(signals[0]!.conversation?.sessionId).not.toBe(signals[1]!.conversation?.sessionId); // …different sessions
  });

  it('skips sessions without observations and non-directory entries', () => {
    writeSessionLedger('with-obs', 'Date: May 20, 2026\n* 🟢 (10:00) only one');
    mkdirSync(join(workspaceRoot, 'sessions', 'empty-session'), { recursive: true });
    writeFileSync(join(workspaceRoot, 'sessions', 'stray-file.txt'), 'not a session', 'utf-8');

    const signals = loadWorkspaceObservationSignals(workspaceRoot);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.summary).toBe('only one');
  });
});
