/**
 * Discoverable coverage for the Step-0 background-subagent routing gate
 * (ORCHA §bg-child-sessions) in `runPreToolUseChecks()`.
 *
 * The full pipeline suite (`pre-tool-use-checks.isolated.ts`) already asserts
 * this gate, but that file uses module-level `mock.module()` overrides and is
 * deliberately named `*.isolated.ts` so it is excluded from bun's default
 * `*.test.ts` discovery (running it alongside other files would leak those
 * mocks). That means `bun test src/agent/core` — the command this feature's
 * gates are measured against — never actually executes it, so mutants in the
 * Step-0 block survive under the standard run. Step-0 is the first check in
 * the pipeline and returns before touching anything the isolated file mocks
 * (mode-manager, permissions-config, fs, config validators, …), so it can be
 * exercised here directly against the real `pre-tool-use.ts` module with no
 * mocking at all.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import {
  runPreToolUseChecks,
  type PreToolUseInput,
  type PermissionManagerLike,
} from '../pre-tool-use.ts';

function createMockPermissionManager(): PermissionManagerLike {
  return {
    isCommandWhitelisted: () => false,
    isDangerousCommand: () => false,
    getBaseCommand: (cmd: string) => cmd.split(/\s+/)[0] || cmd,
    extractDomainFromNetworkCommand: () => null,
    isDomainWhitelisted: () => false,
  };
}

function createInput(overrides?: Partial<PreToolUseInput>): PreToolUseInput {
  return {
    toolName: 'Read',
    input: { file_path: '/test/file.ts' },
    sessionId: 'test-session',
    permissionMode: 'allow-all',
    workspaceRootPath: '/test/workspace',
    workspaceId: 'test-ws',
    activeSourceSlugs: [],
    allSourceSlugs: [],
    hasSourceActivation: true,
    permissionManager: createMockPermissionManager(),
    ...overrides,
  };
}

describe('runPreToolUseChecks > step 0: background-subagent routing gate', () => {
  const ORIGINAL_STREAMING = process.env.ORCHA_STREAMING_MODE;
  const ORIGINAL_FLAG = process.env.ORCHA_BG_CHILD_SESSIONS;

  afterEach(() => {
    if (ORIGINAL_STREAMING === undefined) delete process.env.ORCHA_STREAMING_MODE;
    else process.env.ORCHA_STREAMING_MODE = ORIGINAL_STREAMING;
    if (ORIGINAL_FLAG === undefined) delete process.env.ORCHA_BG_CHILD_SESSIONS;
    else process.env.ORCHA_BG_CHILD_SESSIONS = ORIGINAL_FLAG;
  });

  it('blocks with the exact deny reason (full text, kills word-level mutants)', () => {
    process.env.ORCHA_STREAMING_MODE = '1';
    delete process.env.ORCHA_BG_CHILD_SESSIONS;

    const result = runPreToolUseChecks(createInput({
      toolName: 'Task',
      input: { run_in_background: true },
    }));

    expect(result.type).toBe('block');
    if (result.type !== 'block') return;
    expect(result.reason).toBe(
      'Background subagents run as independent child sessions in this app. ' +
      'Use `spawn_session` with your prompt; the result will be delivered to you ' +
      'automatically as a message. For parallel work you want to wait on, call Agent ' +
      'without run_in_background.',
    );
  });

  it('denies an Agent tool call the same as Task', () => {
    process.env.ORCHA_STREAMING_MODE = '1';
    delete process.env.ORCHA_BG_CHILD_SESSIONS;

    const result = runPreToolUseChecks(createInput({
      toolName: 'Agent',
      input: { run_in_background: true },
    }));

    expect(result.type).toBe('block');
  });

  it('does not gate unrelated tools even under streaming+flag', () => {
    process.env.ORCHA_STREAMING_MODE = '1';
    delete process.env.ORCHA_BG_CHILD_SESSIONS;

    const result = runPreToolUseChecks(createInput({
      toolName: 'Read',
      input: { file_path: '/test/file.ts' },
    }));

    expect(result.type).toBe('allow');
  });

  // streaming | flag  | background | outcome  (bg-child-routing-02 matrix)
  const MATRIX: Array<{
    streaming: string | undefined;
    flag: string | undefined;
    background: boolean | undefined;
    outcome: 'denied' | 'allowed';
  }> = [
    { streaming: '1', flag: undefined, background: true, outcome: 'denied' },
    { streaming: '1', flag: '1', background: true, outcome: 'denied' },
    { streaming: '1', flag: '0', background: true, outcome: 'allowed' },
    { streaming: '0', flag: undefined, background: true, outcome: 'allowed' },
    { streaming: '0', flag: '1', background: true, outcome: 'allowed' },
    { streaming: '1', flag: '1', background: false, outcome: 'allowed' },
  ];

  for (const row of MATRIX) {
    it(`streaming=${row.streaming ?? 'unset'} flag=${row.flag ?? 'unset'} background=${row.background ?? 'unset'} -> ${row.outcome}`, () => {
      if (row.streaming === undefined) delete process.env.ORCHA_STREAMING_MODE;
      else process.env.ORCHA_STREAMING_MODE = row.streaming;
      if (row.flag === undefined) delete process.env.ORCHA_BG_CHILD_SESSIONS;
      else process.env.ORCHA_BG_CHILD_SESSIONS = row.flag;

      const input: Record<string, unknown> = {};
      if (row.background !== undefined) input.run_in_background = row.background;

      const result = runPreToolUseChecks(createInput({
        toolName: 'Task',
        input,
      }));

      expect(result.type).toBe(row.outcome === 'denied' ? 'block' : 'allow');
    });
  }
});
