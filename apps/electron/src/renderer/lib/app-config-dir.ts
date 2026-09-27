/**
 * Orcha Agents fork: config dir name for renderer-side display strings and
 * default paths. The renderer has no access to CONFIG_DIR (node-only,
 * packages/shared/src/config/paths.ts); the packaged main process pins
 * CRAFT_CONFIG_DIR to ~/.orcha-agents via the esbuild banner
 * (scripts/electron-build-main.ts), so the fork default is used here.
 * Upstream hardcodes `.craft-agent` in these places — see FORK.md §3.
 */
export const APP_CONFIG_DIR_NAME = '.orcha-agents'

/** e.g. `~/.orcha-agents` — for agent-facing prompt text built in the renderer */
export const APP_CONFIG_DIR_DISPLAY = `~/${APP_CONFIG_DIR_NAME}`
