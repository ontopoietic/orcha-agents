/**
 * Per-session Claude auth env (Fork §15: connection failover).
 *
 * Upstream puts a connection's credentials only into the global `process.env`, which every
 * session shares. The SDK subprocess copies `process.env` when it spawns, so another session's
 * `postInit()` or `reinitializeAuth()` running in between hands it the wrong account. With two
 * Claude accounts that sent a session moved to account B out with account A's token (and A's
 * usage limit). The session's own credentials therefore also go into its `envOverrides`, which
 * `buildClaudeSubprocessEnv` spreads after `process.env`.
 */

/** Auth keys a session pins; the one its connection does not use is blanked ('' = unset). */
const PINNED_AUTH_KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] as const

export function buildSessionAuthEnvOverrides(authEnv: Record<string, string>): Record<string, string> {
  const overrides: Record<string, string> = { ...authEnv }
  // Connections whose credentials come from the environment (authType 'environment', non-Claude
  // providers) inject nothing — leave the inherited env alone.
  if (!PINNED_AUTH_KEYS.some(key => key in authEnv)) return overrides
  for (const key of PINNED_AUTH_KEYS) {
    if (!(key in overrides)) overrides[key] = ''
  }
  return overrides
}
