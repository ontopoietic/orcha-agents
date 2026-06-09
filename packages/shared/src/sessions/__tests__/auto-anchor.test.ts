import { describe, it, expect } from 'bun:test';
import {
  buildAutoAnchorPrompt,
  parseAutoAnchorResponse,
  mergeAssignmentsIntoSidecar,
  type AnchorCandidate,
  type SidecarEntry,
} from '../auto-anchor.ts';

const NOW = '2026-06-06T20:00:00.000Z';
const CANDIDATES: AnchorCandidate[] = [
  { type: 'feature', id: 'feat-1', title: 'Userflow Graph 2D' },
  { type: 'befund', id: 'bef-1', title: 'Observer never triggered' },
];

describe('buildAutoAnchorPrompt', () => {
  it('lists candidates and observations and forbids inventing IDs', () => {
    const { system, user } = buildAutoAnchorPrompt(
      [{ shortId: 'aaa111', summary: 'Chose 2D layout', excerpt: 'render in 2D' }],
      CANDIDATES,
    );
    expect(system).toContain('ONLY use anchor IDs from the provided candidate list');
    expect(user).toContain('feat-1');
    expect(user).toContain('aaa111');
    expect(user).toContain('Chose 2D layout');
  });
});

describe('parseAutoAnchorResponse', () => {
  it('parses a clean JSON array', () => {
    const out = parseAutoAnchorResponse('[{"shortId":"aaa111","anchorIds":["feat-1"]}]');
    expect(out).toEqual([{ shortId: 'aaa111', anchorIds: ['feat-1'] }]);
  });

  it('extracts JSON embedded in prose / code fences', () => {
    const raw = 'Sure! Here you go:\n```json\n[{"shortId":"x","anchorIds":["feat-1"]}]\n```\nDone.';
    expect(parseAutoAnchorResponse(raw)).toEqual([{ shortId: 'x', anchorIds: ['feat-1'] }]);
  });

  it('drops entries with empty/invalid anchorIds and bad shapes', () => {
    const raw = '[{"shortId":"a","anchorIds":[]},{"shortId":"b"},{"anchorIds":["z"]},{"shortId":"c","anchorIds":["feat-1",123]}]';
    expect(parseAutoAnchorResponse(raw)).toEqual([{ shortId: 'c', anchorIds: ['feat-1'] }]);
  });

  it('returns [] on null / non-JSON / non-array', () => {
    expect(parseAutoAnchorResponse(null)).toEqual([]);
    expect(parseAutoAnchorResponse('no json here')).toEqual([]);
    expect(parseAutoAnchorResponse('{"shortId":"a"}')).toEqual([]);
  });
});

describe('mergeAssignmentsIntoSidecar', () => {
  const baseSidecar = (): Record<string, SidecarEntry> => ({
    aaa111: { fullMessageId: 'msg-1', excerpt: 'e1' },
    bbb222: { fullMessageId: 'msg-2', excerpt: 'e2', anchorRefs: [
      { type: 'feature', id: 'feat-1', title: 'Userflow Graph 2D', addedAt: '2026-05-01T00:00:00.000Z', addedBy: 'user' },
    ] },
  });

  it('adds an anchorRef to an entry that had none', () => {
    const { sidecar, added } = mergeAssignmentsIntoSidecar(
      baseSidecar(), [{ shortId: 'aaa111', anchorIds: ['feat-1'] }], CANDIDATES, NOW,
    );
    expect(added).toBe(1);
    expect(sidecar.aaa111!.anchorRefs).toEqual([
      { type: 'feature', id: 'feat-1', title: 'Userflow Graph 2D', addedAt: NOW, addedBy: 'agent' },
    ]);
  });

  it('is idempotent: does not duplicate an existing type:id (manual anchor preserved)', () => {
    const { sidecar, added } = mergeAssignmentsIntoSidecar(
      baseSidecar(), [{ shortId: 'bbb222', anchorIds: ['feat-1'] }], CANDIDATES, NOW,
    );
    expect(added).toBe(0);
    expect(sidecar.bbb222!.anchorRefs).toHaveLength(1);
    expect(sidecar.bbb222!.anchorRefs![0]!.addedBy).toBe('user'); // original untouched
  });

  it('ignores unknown anchor IDs (closed vocabulary)', () => {
    const { added } = mergeAssignmentsIntoSidecar(
      baseSidecar(), [{ shortId: 'aaa111', anchorIds: ['nope-999'] }], CANDIDATES, NOW,
    );
    expect(added).toBe(0);
  });

  it('reports assignments whose shortId is absent from this sidecar', () => {
    const { added, skippedMissing } = mergeAssignmentsIntoSidecar(
      baseSidecar(), [{ shortId: 'zzz999', anchorIds: ['feat-1'] }], CANDIDATES, NOW,
    );
    expect(added).toBe(0);
    expect(skippedMissing).toEqual(['zzz999']);
  });

  it('does not mutate the input sidecar', () => {
    const input = baseSidecar();
    mergeAssignmentsIntoSidecar(input, [{ shortId: 'aaa111', anchorIds: ['feat-1'] }], CANDIDATES, NOW);
    expect(input.aaa111!.anchorRefs).toBeUndefined();
  });
});
