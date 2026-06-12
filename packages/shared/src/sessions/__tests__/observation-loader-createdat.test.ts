import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  epochFromMessageId,
  stableObservationCreatedAt,
  loadObservationSignals,
  loadObservationSignalsFromMarkdown,
} from '../observation-loader.ts';

describe('epochFromMessageId', () => {
  it('extracts the epoch from a msg-<epoch>-<short> id', () => {
    expect(epochFromMessageId('msg-1779114745824-scap44')).toBe(1779114745824);
  });
  it('returns null for ids without an embedded epoch', () => {
    expect(epochFromMessageId('obs-mastra-3')).toBeNull();
    expect(epochFromMessageId('')).toBeNull();
    expect(epochFromMessageId(undefined)).toBeNull();
    expect(epochFromMessageId(null)).toBeNull();
  });
});

describe('stableObservationCreatedAt', () => {
  const bullet = (date: string | null, time = '') => ({ date, time });

  it('NEVER returns "now" — the bug that re-stamped old bullets every read', () => {
    // No evidence, no date → previously fell back to new Date(). Must be stable.
    const a = stableObservationCreatedAt(bullet(null), undefined);
    const b = stableObservationCreatedAt(bullet(null), undefined);
    expect(a).toBe('');
    expect(b).toBe('');
  });

  it('is deterministic across repeated reads', () => {
    const ev = { fullMessageId: 'msg-1779114745824-scap44' };
    const first = stableObservationCreatedAt(bullet('2026-05-28', '4:32'), ev);
    const second = stableObservationCreatedAt(bullet('2026-05-28', '4:32'), ev);
    expect(first).toBe(second);
  });

  it('prefers the message-epoch (real content time) over run-time', () => {
    const ev = {
      fullMessageId: 'msg-1779114745824-scap44',
      createdAt: '2026-06-03T10:00:00.000Z', // run-time, more recent
    };
    expect(stableObservationCreatedAt(bullet('2026-05-28', '4:32'), ev)).toBe(
      new Date(1779114745824).toISOString(),
    );
  });

  it('falls back to run-time when no epoch is resolvable', () => {
    const ev = { createdAt: '2026-05-28T09:04:41.815Z' };
    expect(stableObservationCreatedAt(bullet('2026-05-28', '4:32'), ev)).toBe(
      '2026-05-28T09:04:41.815Z',
    );
  });

  it('zero-pads single-digit-hour ledger times into a valid stable timestamp', () => {
    // "5:41" previously produced an invalid ISO → new Date() (now). Now stable.
    const got = stableObservationCreatedAt(bullet('2026-05-25', '5:41'), undefined);
    expect(got).toBe(new Date('2026-05-25T05:41:00').toISOString());
  });

  it('falls back to date-at-midnight when the time is unparseable', () => {
    const got = stableObservationCreatedAt(bullet('2026-05-25', 'garbage'), undefined);
    expect(got).toBe(new Date('2026-05-25T00:00:00').toISOString());
  });
});

describe('loader uses stable createdAt (regression: no now-fallback)', () => {
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'obs-loader-'));
    mkdirSync(join(sessionDir, 'data'), { recursive: true });
  });

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true });
  });

  const writeData = (name: string, content: string) =>
    writeFileSync(join(sessionDir, 'data', name), content, 'utf-8');

  it('legacy ledger: bullets without date/time/evidence get "", never the current time', () => {
    // The legacy loader previously fell back to new Date().toISOString() —
    // old bullets re-stamped to "now" on every read and floated to the top.
    writeData('observations.md', '- 🟢 dateless bullet without anchor');
    const signals = loadObservationSignalsFromMarkdown(sessionDir)!;
    expect(signals).toHaveLength(1);
    expect(signals[0]!.createdAt).toBe('');
  });

  it('legacy ledger: message-epoch in evidence beats observer run-time', () => {
    writeData('observations.md', ['# 2026-05-28', '- 🔴 14:30 big decision {abc123}'].join('\n'));
    writeData(
      'observations-evidence.json',
      JSON.stringify({
        abc123: {
          fullMessageId: 'msg-1779114745824-abc123',
          createdAt: '2026-06-03T10:00:00.000Z', // later run-time must NOT win
        },
      }),
    );
    const signals = loadObservationSignalsFromMarkdown(sessionDir)!;
    expect(signals[0]!.createdAt).toBe(new Date(1779114745824).toISOString());
  });

  it('mastra ledger: dateless bullets get "" instead of the current time', () => {
    writeData('observations.mastra.md', '* 🟢 dateless mastra bullet');
    const signals = loadObservationSignals(sessionDir);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.createdAt).toBe('');
  });

  it('repeated reads produce identical createdAt values', () => {
    writeData(
      'observations.mastra.md',
      ['Date: May 28, 2026', '* 🔴 (14:30) stable bullet'].join('\n'),
    );
    const first = loadObservationSignals(sessionDir);
    const second = loadObservationSignals(sessionDir);
    expect(first.map((s) => s.createdAt)).toEqual(second.map((s) => s.createdAt));
    expect(first[0]!.createdAt).not.toBe('');
  });
});
