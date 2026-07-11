/**
 * ORCHA §bg-child-sessions — feature flag for rerouting background subagent
 * spawns onto independent child sessions instead of in-query background tasks.
 *
 * Read fresh on each call (no module-level caching) so tests/users can toggle
 * without a process restart — mirrors `isStreamingModeEnabled()` in
 * `message-provider.ts`.
 */

/**
 * Whether the `ORCHA_BG_CHILD_SESSIONS` flag itself is enabled. Default ON;
 * opt out with `=0`/`=false` (kill switch — restores upstream in-query
 * background-task behavior even under streaming mode).
 *
 * This flag alone does not gate rerouting — callers must also check
 * `isStreamingModeEnabled()` (streaming mode is what makes rerouting safe,
 * since only then does keep-alive no longer need the persistent query).
 */
export function isBgChildSessionsFlagEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const v = env.ORCHA_BG_CHILD_SESSIONS;
  return v !== '0' && v !== 'false';
}
