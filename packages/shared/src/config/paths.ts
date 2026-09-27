/**
 * Centralized path configuration for Orcha Agents.
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
 */

import { homedir } from 'os';
import { join } from 'path';

const ORCHA_DIR = join(homedir(), '.orcha-agents');

function resolveConfigDir(): string {
  if (process.env.CRAFT_CONFIG_DIR) return process.env.CRAFT_CONFIG_DIR;
  return ORCHA_DIR;
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
