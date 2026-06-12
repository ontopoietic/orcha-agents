import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ORCHA_SCRIPT_BASES,
  resolveOrchaScript,
  validateOrchaScriptRuntime,
} from '../observer-runtime.ts';

let appRoot: string;

beforeEach(() => {
  appRoot = mkdtempSync(join(tmpdir(), 'orcha-runtime-test-'));
});

afterEach(() => {
  rmSync(appRoot, { recursive: true, force: true });
});

function writeCjsBundles(bases: readonly string[]): void {
  const dir = join(appRoot, 'dist', 'observer-scripts');
  mkdirSync(dir, { recursive: true });
  for (const b of bases) writeFileSync(join(dir, `${b}.cjs`), '// bundle', 'utf-8');
}

function writeTsSources(bases: readonly string[]): void {
  const dir = join(appRoot, 'scripts');
  mkdirSync(dir, { recursive: true });
  for (const b of bases) writeFileSync(join(dir, `${b}.ts`), '// source', 'utf-8');
}

describe('validateOrchaScriptRuntime', () => {
  it('reports ok with packaged-cjs mode when all bundles exist', () => {
    writeCjsBundles(ORCHA_SCRIPT_BASES);
    const report = validateOrchaScriptRuntime(appRoot);
    expect(report.ok).toBe(true);
    expect(report.mode).toBe('packaged-cjs');
    expect(report.missing).toEqual([]);
  });

  it('reports ok with dev-tsx mode when only TS sources exist', () => {
    writeTsSources(ORCHA_SCRIPT_BASES);
    const report = validateOrchaScriptRuntime(appRoot);
    expect(report.ok).toBe(true);
    expect(report.mode).toBe('dev-tsx');
    expect(report.missing).toEqual([]);
  });

  it('lists exactly the scripts that resolve to neither bundle nor source', () => {
    writeCjsBundles(['orcha-observe', 'orcha-reflect']);
    const report = validateOrchaScriptRuntime(appRoot);
    expect(report.ok).toBe(false);
    expect(report.missing.sort()).toEqual(['orcha-episode-emit', 'orcha-recall-anchors']);
  });

  it('reports every script missing for an empty app root', () => {
    const report = validateOrchaScriptRuntime(appRoot);
    expect(report.ok).toBe(false);
    expect(report.mode).toBe('missing');
    expect(report.missing.length).toBe(ORCHA_SCRIPT_BASES.length);
  });
});

describe('resolveOrchaScript', () => {
  it('prefers the packaged CJS bundle over the TS source', () => {
    writeCjsBundles(['orcha-observe']);
    writeTsSources(['orcha-observe']);
    const inv = resolveOrchaScript(appRoot, 'orcha-observe', ['/some/session']);
    expect(inv?.mode).toBe('packaged-cjs');
    expect(inv?.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(inv?.args.at(-1)).toBe('/some/session');
  });

  it('returns null when the script exists in neither location', () => {
    expect(resolveOrchaScript(appRoot, 'orcha-observe', [])).toBeNull();
  });
});
