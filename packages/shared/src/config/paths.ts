/**
 * Centralized path configuration for Orcha Agents.
 *
 * `CONFIG_DIR` is the one place that decides where the app keeps its state
 * (`~/.orcha-agents` by default in the fork). Every other module joins onto it;
 * never join `homedir()` with a config dir name directly (OSS #1062).
 *
 * Resolution order:
 *   1. CRAFT_CONFIG_DIR environment variable (explicit override — used by
 *      the multi-instance detect-instance.sh script, which points at
 *      ~/.craft-agent-1, ~/.craft-agent-2 etc. for parallel dev runs)
 *   2. ~/.orcha-agents/ (fork default; created on first launch)
 *
 * Fork (Orcha Agents): the app is fully independent of the original Craft
 * Agents app. There is deliberately NO fallback to ~/.craft-agent — Orcha
 * never reads or writes the original app's data dir at runtime, except as
 * the read-only source of the one-time isolation migration
 * (./isolation-migration.ts). See FORK.md §3.
 *
 * Two modules re-derive this from the environment on purpose because they must
 * stay import-free: `interceptor-common.ts` (preloaded into the Pi subprocess)
 * and session-tools-core `handlers/config-validate.ts` (no dependency on shared).
 * Both must use the same fork default (`.orcha-agents`).
 */

import { homedir } from 'os';
import { join } from 'path';

/** Fork (Orcha Agents): upstream default is `.craft-agent`. */
export const DEFAULT_CONFIG_DIR_NAME = '.orcha-agents';

/**
 * Resolve the config directory: a non-empty CRAFT_CONFIG_DIR wins, otherwise
 * `<home>/.orcha-agents`. Pure; `CONFIG_DIR` is this evaluated once at load.
 */
export function resolveConfigDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const override = env.CRAFT_CONFIG_DIR?.trim();
  return override ? override : join(home, DEFAULT_CONFIG_DIR_NAME);
}

export const CONFIG_DIR = resolveConfigDir();

/**
 * Fork (Orcha Agents): CONFIG_DIR for agent-facing text (system prompt, tool
 * descriptions, synced docs), with the home dir collapsed to `~` — e.g.
 * `~/.orcha-agents`. Upstream hardcodes `~/.craft-agent` (docs APP_ROOT);
 * see FORK.md §3 "Agent-facing config paths".
 */
export const CONFIG_DIR_DISPLAY = toTildePath(CONFIG_DIR);

function toTildePath(absPath: string): string {
  const normalized = absPath.replace(/\\/g, '/');
  const home = homedir().replace(/\\/g, '/').replace(/\/+$/, '');
  if (home && (normalized === home || normalized.startsWith(home + '/'))) {
    return '~' + normalized.slice(home.length);
  }
  return normalized;
}

/**
 * Fork (Orcha Agents): per-workspace messaging bindings dir,
 * `CONFIG_DIR/workspaces/{wsId}/messaging`. Upstream hardcoded
 * `~/.craft-agent/workspaces/{wsId}/messaging` in both Electron main and the
 * headless server, which pointed the fork at the original app's bindings.
 */
export function getMessagingDir(workspaceId: string, configDir: string = CONFIG_DIR): string {
  return join(configDir, 'workspaces', workspaceId, 'messaging');
}
