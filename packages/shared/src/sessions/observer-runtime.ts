/**
 * Observer-family script runtime resolution.
 *
 * The Observer / Reflector / Recall-anchor helpers live as standalone
 * scripts under `scripts/orcha-*.ts` and are spawned as detached
 * child processes. In DEV the spawn is `npx tsx scripts/<name>.ts` — tsx
 * resolves from node_modules and runs the TypeScript directly.
 *
 * That path is DEAD in packaged builds: neither the `.ts` sources nor `tsx`
 * ship in the app bundle, so `existsSync(scriptPath)` is false and every
 * trigger silently no-ops — the watermark freezes and no observations are
 * ever written. (This is the bug behind "the UI shows no new observations
 * since I switched to the packaged app".)
 *
 * Fix: the build esbuild-bundles each script into a self-contained CJS at
 *   <appRoot>/dist/observer-scripts/<name>.cjs
 * (shipped via electron-builder `files: dist/**`). In packaged builds we run
 * that CJS with the Electron binary in Node mode (ELECTRON_RUN_AS_NODE=1) —
 * no tsx, no npx, no registry. Dev keeps the tsx path (no bundle present).
 *
 * `resolveOrchaScript` centralises this decision so every spawn site stays
 * identical and there is exactly one place to evolve the runtime strategy.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Base names (without extension) of the spawnable orcha helper scripts. */
export type OrchaScriptBase =
  | 'orcha-observe'
  | 'orcha-reflect'
  | 'orcha-recall-anchors';

/** Every spawnable script — keep in sync with OrchaScriptBase. */
export const ORCHA_SCRIPT_BASES: readonly OrchaScriptBase[] = [
  'orcha-observe',
  'orcha-reflect',
  'orcha-recall-anchors',
];

export interface ResolvedScriptInvocation {
  /** Executable to spawn (process.execPath for packaged, 'npx' for dev). */
  command: string;
  /** Full argv after the command. */
  args: string[];
  /**
   * Env overrides to merge into the spawn's `env` (last, so they win).
   * Empty for the dev/tsx path; `{ ELECTRON_RUN_AS_NODE: '1' }` for packaged.
   */
  env: Record<string, string>;
  /** Which path was chosen — for diagnostics/logging. */
  mode: 'packaged-cjs' | 'dev-tsx';
}

/**
 * Resolve how to invoke an orcha helper script given the app root and the
 * script-specific arguments (e.g. `[sessionDir]` or `[sessionDir, reason]`).
 *
 * Returns null when neither the bundled CJS nor the TS source exists, so the
 * caller can log-and-return exactly as it did before.
 */
export function resolveOrchaScript(
  appRoot: string,
  base: OrchaScriptBase,
  scriptArgs: string[],
): ResolvedScriptInvocation | null {
  // Packaged: prefer the esbuild-bundled CJS, run via Electron-as-Node.
  const cjs = join(appRoot, 'dist', 'observer-scripts', `${base}.cjs`);
  if (existsSync(cjs)) {
    return {
      command: process.execPath,
      args: [cjs, ...scriptArgs],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      mode: 'packaged-cjs',
    };
  }
  // Dev: run the TypeScript source directly via tsx.
  const ts = join(appRoot, 'scripts', `${base}.ts`);
  if (existsSync(ts)) {
    return {
      command: 'npx',
      args: ['tsx', ts, ...scriptArgs],
      env: {},
      mode: 'dev-tsx',
    };
  }
  return null;
}

export interface OrchaScriptRuntimeReport {
  /** True iff every script in ORCHA_SCRIPT_BASES is spawnable. */
  ok: boolean;
  /** Runtime the resolvable scripts use; 'missing' when none resolve. */
  mode: 'packaged-cjs' | 'dev-tsx' | 'missing';
  /** Scripts that resolve to neither a bundled CJS nor a TS source. */
  missing: OrchaScriptBase[];
}

/**
 * Startup check for the whole memory-script runtime. A missing bundle in a
 * packaged build is otherwise SILENT: every trigger no-ops, the watermark
 * freezes, and no observations are written (this shipped once — see the
 * module doc above). Call this once at app startup and surface a loud error
 * when `ok` is false instead of waiting for users to notice stale memory.
 */
export function validateOrchaScriptRuntime(appRoot: string): OrchaScriptRuntimeReport {
  const missing: OrchaScriptBase[] = [];
  let mode: OrchaScriptRuntimeReport['mode'] = 'missing';
  for (const base of ORCHA_SCRIPT_BASES) {
    const inv = resolveOrchaScript(appRoot, base, []);
    if (!inv) missing.push(base);
    else if (mode === 'missing') mode = inv.mode;
  }
  return { ok: missing.length === 0, mode, missing };
}
