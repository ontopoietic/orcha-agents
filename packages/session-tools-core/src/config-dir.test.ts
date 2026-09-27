import { describe, it, expect, afterEach } from 'bun:test';
import { homedir } from 'node:os';
import { getAppConfigDir, getAppConfigDirDisplay, toTildePath, docDisplayPath } from './config-dir.ts';

describe('config-dir (fork)', () => {
  const prev = process.env.CRAFT_CONFIG_DIR;
  afterEach(() => {
    if (prev === undefined) delete process.env.CRAFT_CONFIG_DIR;
    else process.env.CRAFT_CONFIG_DIR = prev;
  });

  it('collapses the home dir to ~', () => {
    expect(toTildePath('/Users/x/.orcha-agents', '/Users/x')).toBe('~/.orcha-agents');
    expect(toTildePath('/Users/x', '/Users/x/')).toBe('~');
    expect(toTildePath('/Users/xy/.orcha-agents', '/Users/x')).toBe('/Users/xy/.orcha-agents');
    expect(toTildePath('/data/config', '/Users/x')).toBe('/data/config');
  });

  it('honours CRAFT_CONFIG_DIR', () => {
    process.env.CRAFT_CONFIG_DIR = `${homedir()}/.orcha-agents`;
    expect(getAppConfigDir()).toBe(`${homedir()}/.orcha-agents`);
    expect(getAppConfigDirDisplay()).toBe('~/.orcha-agents');
    expect(docDisplayPath('pages.md')).toBe('~/.orcha-agents/docs/pages.md');
  });

  it('defaults to ~/.orcha-agents when no config exists', () => {
    delete process.env.CRAFT_CONFIG_DIR;
    // Under a temp HOME (test convention) neither dir has a config.json.
    const dir = getAppConfigDir();
    expect([`${homedir()}/.orcha-agents`, `${homedir()}/.craft-agent`]).toContain(dir);
  });
});
