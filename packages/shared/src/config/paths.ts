/**
 * Centralized path configuration for Orcha Agents.
 *
 * Resolution order:
 *   1. CRAFT_CONFIG_DIR environment variable (explicit override — used by
 *      the multi-instance detect-instance.sh script, which points at
 *      ~/.craft-agent-1, ~/.craft-agent-2 etc. for parallel dev runs)
 *   2. ~/.orcha-agents/ if it already contains a config.json — this is
 *      the fork-native location and should be preferred when present
 *   3. ~/.craft-agent/ if it already contains a config.json — upstream
 *      compatibility for users migrating from the original craft-agent
 *   4. ~/.orcha-agents/ as the new default (created on first launch)
 *
 * The auto-discovery in steps 2-3 means a freshly-cloned orcha-agents
 * checkout finds existing data without needing CRAFT_CONFIG_DIR exported
 * in the user's shell. Setting the env var still wins, so multi-instance
 * dev and CI overrides continue to work.
 */

import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const ORCHA_DIR = join(homedir(), '.orcha-agents');
const CRAFT_DIR = join(homedir(), '.craft-agent');

function resolveConfigDir(): string {
  if (process.env.CRAFT_CONFIG_DIR) return process.env.CRAFT_CONFIG_DIR;
  if (existsSync(join(ORCHA_DIR, 'config.json'))) return ORCHA_DIR;
  if (existsSync(join(CRAFT_DIR, 'config.json'))) return CRAFT_DIR;
  return ORCHA_DIR;
}

export const CONFIG_DIR = resolveConfigDir();
