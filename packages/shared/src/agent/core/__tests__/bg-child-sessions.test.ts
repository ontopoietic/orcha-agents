import { describe, it, expect, afterEach } from 'bun:test';
import { isBgChildSessionsFlagEnabled } from '../bg-child-sessions.ts';
import { isStreamingModeEnabled } from '../message-provider.ts';
import { resolveKeepBackgroundTasksAlive } from '../../backend/claude/persistent-input.ts';

describe('isBgChildSessionsFlagEnabled', () => {
  it('is ON by default (unset)', () => {
    expect(isBgChildSessionsFlagEnabled({})).toBe(true);
  });
  it('is ON for any value other than the kill-switch', () => {
    expect(isBgChildSessionsFlagEnabled({ ORCHA_BG_CHILD_SESSIONS: '1' })).toBe(true);
  });
  it('is OFF for "0"/"false" (kill switch)', () => {
    expect(isBgChildSessionsFlagEnabled({ ORCHA_BG_CHILD_SESSIONS: '0' })).toBe(false);
    expect(isBgChildSessionsFlagEnabled({ ORCHA_BG_CHILD_SESSIONS: 'false' })).toBe(false);
  });
});

describe('keep-alive lifecycle matrix (bg-child-keepalive-01)', () => {
  const ORIGINAL_STREAMING = process.env.ORCHA_STREAMING_MODE;
  const ORIGINAL_KEEP_ALIVE = process.env.CRAFT_KEEP_BG_AGENTS_ALIVE;

  afterEach(() => {
    if (ORIGINAL_STREAMING === undefined) delete process.env.ORCHA_STREAMING_MODE;
    else process.env.ORCHA_STREAMING_MODE = ORIGINAL_STREAMING;
    if (ORIGINAL_KEEP_ALIVE === undefined) delete process.env.CRAFT_KEEP_BG_AGENTS_ALIVE;
    else process.env.CRAFT_KEEP_BG_AGENTS_ALIVE = ORIGINAL_KEEP_ALIVE;
  });

  // Mirrors the exact expression used for `keepBackgroundTasksAlive` in claude-agent.ts:
  //   resolveKeepBackgroundTasksAlive() && !isStreamingModeEnabled()
  function effectiveKeepAlive(): boolean {
    return resolveKeepBackgroundTasksAlive() && !isStreamingModeEnabled();
  }

  const MATRIX: Array<{
    streaming: string | undefined;
    keepAlive: string | undefined;
    expected: boolean;
    label: string;
  }> = [
    { streaming: '1', keepAlive: undefined, expected: false, label: 'torn down after the turn' },
    { streaming: '1', keepAlive: '1', expected: false, label: 'torn down after the turn' },
    { streaming: '0', keepAlive: undefined, expected: true, label: 'kept alive across turns' },
    { streaming: '0', keepAlive: '1', expected: true, label: 'kept alive across turns' },
    { streaming: '0', keepAlive: '0', expected: false, label: 'torn down after the turn' },
  ];

  for (const row of MATRIX) {
    it(`streaming=${row.streaming} keepAlive=${row.keepAlive ?? 'unset'} -> ${row.label}`, () => {
      if (row.streaming === undefined) delete process.env.ORCHA_STREAMING_MODE;
      else process.env.ORCHA_STREAMING_MODE = row.streaming;
      if (row.keepAlive === undefined) delete process.env.CRAFT_KEEP_BG_AGENTS_ALIVE;
      else process.env.CRAFT_KEEP_BG_AGENTS_ALIVE = row.keepAlive;

      expect(effectiveKeepAlive()).toBe(row.expected);
    });
  }
});
