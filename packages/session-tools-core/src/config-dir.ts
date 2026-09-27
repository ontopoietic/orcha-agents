/**
 * Orcha Agents fork: app config dir resolution for session tools.
 *
 * Upstream hardcodes `~/.craft-agent` in several agent-facing strings and in
 * the basic config_validate fallback. The fork isolates its data under
 * `~/.orcha-agents` (see FORK.md §3), so agent-facing paths must be derived
 * from the real config dir instead.
 *
 * This MIRRORS `resolveConfigDir()` in packages/shared/src/config/paths.ts —
 * it cannot import it because @craft-agent/shared depends on this package.
 * Keep both in sync.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Absolute path of the app config dir (CRAFT_CONFIG_DIR → ~/.orcha-agents → ~/.craft-agent → ~/.orcha-agents). */
export function getAppConfigDir(): string {
  if (process.env.CRAFT_CONFIG_DIR) return process.env.CRAFT_CONFIG_DIR;
  const orcha = join(homedir(), '.orcha-agents');
  if (existsSync(join(orcha, 'config.json'))) return orcha;
  const craft = join(homedir(), '.craft-agent');
  if (existsSync(join(craft, 'config.json'))) return craft;
  return orcha;
}

/** Collapse the user's home dir prefix to `~` for display in prompts/tool descriptions. */
export function toTildePath(absPath: string, home: string = homedir()): string {
  const normalized = absPath.replace(/\\/g, '/');
  const normalizedHome = home.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalizedHome && (normalized === normalizedHome || normalized.startsWith(normalizedHome + '/'))) {
    return '~' + normalized.slice(normalizedHome.length);
  }
  return normalized;
}

/** Display form of the config dir, e.g. `~/.orcha-agents`. */
export function getAppConfigDirDisplay(): string {
  return toTildePath(getAppConfigDir());
}

/** Display path of a bundled doc, e.g. `~/.orcha-agents/docs/pages.md`. */
export function docDisplayPath(filename: string): string {
  return `${getAppConfigDirDisplay()}/docs/${filename}`;
}
