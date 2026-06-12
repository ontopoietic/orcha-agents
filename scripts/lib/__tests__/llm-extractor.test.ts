import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { resolveExtractor, buildCliSpawnEnv } from '../llm-extractor.ts';

// Env keys the extractor consults — saved/restored around every test so the
// suite is independent of the developer's shell environment.
const ENV_KEYS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ORCHA_OBSERVER_API_KEY',
  'ORCHA_OBSERVER_MODEL',
  'ORCHA_OBSERVER_CLI_PATH',
  'CRAFT_APP_ROOT',
  'ELECTRON_RUN_AS_NODE',
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('buildCliSpawnEnv', () => {
  it('strips ELECTRON_RUN_AS_NODE so the claude binary does not inherit Node mode', () => {
    // In packaged builds the orcha scripts themselves run under
    // ELECTRON_RUN_AS_NODE=1; the standalone `claude` CLI must NOT inherit it.
    process.env.ELECTRON_RUN_AS_NODE = '1';
    const env = buildCliSpawnEnv();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('passes the rest of the environment through', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok-123';
    const env = buildCliSpawnEnv();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok-123');
  });
});

describe('resolveExtractor', () => {
  it('returns null when no auth is available', () => {
    expect(resolveExtractor()).toBeNull();
  });

  it('prefers CLI mode when an OAuth token and explicit CLI path are present', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
    process.env.ORCHA_OBSERVER_CLI_PATH = '/fake/claude';
    const mode = resolveExtractor();
    expect(mode).toEqual({ kind: 'cli', cliPath: '/fake/claude', model: 'claude-sonnet-4-6' });
  });

  it('falls back to API mode on ANTHROPIC_API_KEY', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const mode = resolveExtractor();
    expect(mode?.kind).toBe('api');
    if (mode?.kind === 'api') expect(mode.apiKey).toBe('sk-test');
  });

  it('honors caller-supplied model env keys and defaultModel in order', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.MY_MODEL = 'claude-haiku-4-5-20251001';
    try {
      const withEnv = resolveExtractor({ modelEnvKeys: ['MY_MODEL'], defaultModel: 'fallback-model' });
      expect(withEnv?.model).toBe('claude-haiku-4-5-20251001');
      delete process.env.MY_MODEL;
      const withDefault = resolveExtractor({ modelEnvKeys: ['MY_MODEL'], defaultModel: 'fallback-model' });
      expect(withDefault?.model).toBe('fallback-model');
    } finally {
      delete process.env.MY_MODEL;
    }
  });
});
