/**
 * Reflection Trigger — auto-fires the L2 Reflector when observation
 * volume crosses Mastra's 40k-observation-tokens threshold.
 *
 * Pairs with observation-trigger.ts (which fires the L1 Observer at 30k
 * raw-conversation tokens). Observer condenses raw turns → observations;
 * Reflector condenses old observations → denser L2 items + bridge to the
 * Orcha-CLI ledger. Without this auto-trigger, observations.md/.json grow
 * unboundedly until manual "Reflect & condense" is clicked in the UI.
 *
 * Env vars:
 *   ORCHA_REFLECTOR_THRESHOLD_OBSERVATIONS default 60 (primary: top-level
 *                                        bullet count — the unit the Reflector
 *                                        condenses and the user reasons about)
 *   ORCHA_REFLECTOR_THRESHOLD_TOKENS     default 20000 (backstop: chars/4 of
 *                                        the largest ledger; rarely reached by
 *                                        a per-session ledger, so the count
 *                                        trigger is what actually fires)
 *   ORCHA_REFLECTOR_MIN_INTERVAL_SECONDS default 120
 *   ORCHA_REFLECTOR_DISABLE_TRIGGER      "1" to opt out entirely
 *
 * Design notes:
 * - Fires when EITHER the bullet count or the token estimate crosses threshold.
 *   The token estimate is chars/4 over the LARGEST of observations.mastra.md,
 *   observations.md, observations.json — whichever ledger the session is on;
 *   the count is parseAnchoredBullets() over that same markdown ledger.
 * - Throttle is in-memory per session — process restarts reset it.
 * - Spawn is fire-and-forget; the agent's turn is not blocked.
 */

import { existsSync, statSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createLogger } from '../utils/debug.ts';
import { parseAnchoredBullets } from './mastra-om/parse-anchored-bullets.ts';

const log = createLogger('reflection-trigger');

interface ThrottleState {
  lastTriggerMs: number;
  inFlight: boolean;
}

const throttle = new Map<string, ThrottleState>();

interface TriggerConfig {
  thresholdTokens: number;
  thresholdObservations: number;
  minIntervalSeconds: number;
}

function resolveConfig(): TriggerConfig {
  const t = parseInt(process.env.ORCHA_REFLECTOR_THRESHOLD_TOKENS ?? '', 10);
  const o = parseInt(process.env.ORCHA_REFLECTOR_THRESHOLD_OBSERVATIONS ?? '', 10);
  const m = parseInt(process.env.ORCHA_REFLECTOR_MIN_INTERVAL_SECONDS ?? '', 10);
  return {
    thresholdTokens: Number.isFinite(t) && t > 0 ? t : 20_000,
    // Count-based primary trigger. The token threshold (Mastra's per-memory
    // 40k×0.5) is calibrated for cross-conversation memory and is effectively
    // never reached by a per-session ledger (observed max ~340 bullets ≈ 33 KB
    // ≈ 8k tokens = 42 % of threshold) — so the byte path alone never fires.
    // Counting top-level observations matches the unit the Reflector compresses
    // and the user reasons about. Default 60: fires well before the injected
    // ledger becomes a per-turn tax, condensing back to ~20–35 bullets.
    thresholdObservations: Number.isFinite(o) && o > 0 ? o : 60,
    minIntervalSeconds: Number.isFinite(m) && m >= 0 ? m : 120,
  };
}

interface LedgerEstimate {
  /** file-size / 4 of the largest ledger file (legacy byte heuristic). */
  tokens: number;
  /** count of top-level observation bullets in the largest markdown ledger. */
  count: number;
}

/**
 * Measure the LARGEST of `observations.mastra.md` (Mastra path, append-only —
 * primary driver of unbounded growth), `observations.md` (legacy LLM-rewrite
 * path), and `observations.json` (legacy JSON) so the trigger works whichever
 * ledger is currently load-bearing.
 *
 * Returns both a token estimate (file size / 4 — reflection cost is dominated
 * by the prompt-side payload) and a top-level bullet count (the unit the
 * Reflector actually condenses). JSON ledgers yield count 0 — they rely on the
 * token path.
 */
function estimateObservationLedger(sessionDataDir: string): LedgerEstimate {
  let maxSize = 0;
  let largestPath: string | null = null;
  let largestIsMarkdown = false;
  for (const name of ['observations.mastra.md', 'observations.md', 'observations.json']) {
    const p = join(sessionDataDir, name);
    if (!existsSync(p)) continue;
    try {
      const size = statSync(p).size;
      if (size > maxSize) {
        maxSize = size;
        largestPath = p;
        largestIsMarkdown = name.endsWith('.md');
      }
    } catch {
      /* ignore */
    }
  }

  let count = 0;
  if (largestPath && largestIsMarkdown) {
    try {
      count = parseAnchoredBullets(readFileSync(largestPath, 'utf-8')).length;
    } catch {
      /* ignore — fall back to token path */
    }
  }

  return { tokens: Math.floor(maxSize / 4), count };
}

function spawnReflector(
  sessionDir: string,
  sessionId: string,
  envOverride?: Record<string, string>,
): void {
  const appRoot = process.env.CRAFT_APP_ROOT;
  if (!appRoot) {
    log.debug('CRAFT_APP_ROOT not set — cannot spawn reflector');
    return;
  }
  const scriptPath = join(appRoot, 'scripts', 'orcha-reflect.ts');
  if (!existsSync(scriptPath)) {
    log.debug(`Reflector script not found at ${scriptPath}`);
    return;
  }

  const state = throttle.get(sessionId)!;
  state.inFlight = true;

  const child = spawn('npx', ['tsx', scriptPath, sessionDir], {
    cwd: appRoot,
    env: {
      ...process.env,
      CRAFT_WORKSPACE_ROOT: process.env.CRAFT_WORKSPACE_ROOT ?? '',
      // Auth/env injection for callers (e.g. the electron wake-trigger) whose
      // process.env may lack a fresh OAuth token. Applied last so it wins.
      ...(envOverride ?? {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
  child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

  child.on('close', (code) => {
    state.inFlight = false;
    if (code === 0) {
      log.debug(`Reflector (token-trigger) ran for ${sessionId}: ${stdout.trim().slice(0, 200)}`);
    } else {
      log.debug(`Reflector (token-trigger) failed for ${sessionId} (code ${code}): ${stderr.trim().slice(0, 200) || stdout.trim().slice(0, 200)}`);
    }
  });

  child.on('error', (err) => {
    state.inFlight = false;
    log.debug(`Reflector (token-trigger) spawn error for ${sessionId}: ${err.message}`);
  });

  // Reflector is heavier than Observer — give it 180s before we kill.
  setTimeout(() => {
    if (state.inFlight) {
      child.kill('SIGTERM');
      state.inFlight = false;
      log.debug(`Reflector (token-trigger) killed for ${sessionId} (180s timeout)`);
    }
  }, 180_000);
}

/**
 * Decide whether to fire the Reflector for this session, and if so, spawn it.
 * Fire-and-forget — safe to call on every turn.
 */
export function maybeTriggerReflector(
  sessionDir: string,
  sessionId: string,
  opts?: { envOverride?: Record<string, string> },
): { triggered: boolean; reason: string; observationTokens: number; observationCount: number } {
  if (process.env.ORCHA_REFLECTOR_DISABLE_TRIGGER === '1') {
    return { triggered: false, reason: 'disabled by ORCHA_REFLECTOR_DISABLE_TRIGGER', observationTokens: 0, observationCount: 0 };
  }
  if (!existsSync(sessionDir)) {
    return { triggered: false, reason: 'session dir does not exist', observationTokens: 0, observationCount: 0 };
  }

  const config = resolveConfig();
  const { tokens, count } = estimateObservationLedger(join(sessionDir, 'data'));

  // Fire when EITHER the bullet count (primary, per-session-appropriate) or the
  // legacy token estimate (backstop for unusually verbose few-bullet ledgers)
  // crosses its threshold.
  const countHit = count >= config.thresholdObservations;
  const tokensHit = tokens >= config.thresholdTokens;
  if (!countHit && !tokensHit) {
    return {
      triggered: false,
      reason: `below threshold (count ${count}/${config.thresholdObservations}, tokens ${tokens}/${config.thresholdTokens})`,
      observationTokens: tokens,
      observationCount: count,
    };
  }

  const now = Date.now();
  const state = throttle.get(sessionId) ?? { lastTriggerMs: 0, inFlight: false };
  if (state.inFlight) {
    return { triggered: false, reason: 'previous run still in flight', observationTokens: tokens, observationCount: count };
  }
  const sinceLastSec = (now - state.lastTriggerMs) / 1000;
  if (sinceLastSec < config.minIntervalSeconds) {
    return { triggered: false, reason: `throttled (${Math.floor(sinceLastSec)}s < ${config.minIntervalSeconds}s)`, observationTokens: tokens, observationCount: count };
  }

  state.lastTriggerMs = now;
  throttle.set(sessionId, state);

  const trigger = countHit
    ? `count ${count} ≥ ${config.thresholdObservations}`
    : `tokens ${tokens} ≥ ${config.thresholdTokens}`;
  log.debug(`Reflector trigger fires for ${sessionId}: ${trigger}`);
  spawnReflector(sessionDir, sessionId, opts?.envOverride);

  return { triggered: true, reason: `threshold reached (${trigger})`, observationTokens: tokens, observationCount: count };
}

/** Reset throttle for tests or manual runs. */
export function resetReflectionTriggerThrottle(sessionId?: string): void {
  if (sessionId) throttle.delete(sessionId);
  else throttle.clear();
}
