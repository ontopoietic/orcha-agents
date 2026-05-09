/**
 * Reflection Trigger — auto-fires the L2 Reflector when observation
 * volume crosses Mastra's 40k-observation-tokens threshold.
 *
 * Pairs with observation-trigger.ts (which fires the L1 Observer at 30k
 * raw-conversation tokens). Observer condenses raw turns → observations;
 * Reflector condenses old observations → denser L2 items + bridge to the
 * Orcha-CLI ledger. Without this auto-trigger, observations.json grows
 * unboundedly until manual "Reflect & condense" is clicked in the UI.
 *
 * Env vars:
 *   ORCHA_REFLECTOR_THRESHOLD_TOKENS     default 40000
 *   ORCHA_REFLECTOR_MIN_INTERVAL_SECONDS default 120
 *   ORCHA_REFLECTOR_DISABLE_TRIGGER      "1" to opt out entirely
 *
 * Design notes:
 * - Token estimate is chars/4 over the observations.json file (the same
 *   coarse estimator the Reflector itself uses).
 * - Throttle is in-memory per session — process restarts reset it.
 * - Spawn is fire-and-forget; the agent's turn is not blocked.
 */

import { existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createLogger } from '../utils/debug.ts';

const log = createLogger('reflection-trigger');

interface ThrottleState {
  lastTriggerMs: number;
  inFlight: boolean;
}

const throttle = new Map<string, ThrottleState>();

interface TriggerConfig {
  thresholdTokens: number;
  minIntervalSeconds: number;
}

function resolveConfig(): TriggerConfig {
  const t = parseInt(process.env.ORCHA_REFLECTOR_THRESHOLD_TOKENS ?? '', 10);
  const m = parseInt(process.env.ORCHA_REFLECTOR_MIN_INTERVAL_SECONDS ?? '', 10);
  return {
    thresholdTokens: Number.isFinite(t) && t > 0 ? t : 40_000,
    minIntervalSeconds: Number.isFinite(m) && m >= 0 ? m : 120,
  };
}

/**
 * Estimate Reflector "input tokens" by file size of observations.json
 * divided by 4. Reflection cost is dominated by the prompt-side payload.
 */
function estimateObservationTokens(observationsPath: string): number {
  if (!existsSync(observationsPath)) return 0;
  try {
    return Math.floor(statSync(observationsPath).size / 4);
  } catch {
    return 0;
  }
}

function spawnReflector(sessionDir: string, sessionId: string): void {
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
): { triggered: boolean; reason: string; observationTokens: number } {
  if (process.env.ORCHA_REFLECTOR_DISABLE_TRIGGER === '1') {
    return { triggered: false, reason: 'disabled by ORCHA_REFLECTOR_DISABLE_TRIGGER', observationTokens: 0 };
  }
  if (!existsSync(sessionDir)) {
    return { triggered: false, reason: 'session dir does not exist', observationTokens: 0 };
  }

  const config = resolveConfig();
  const observationsPath = join(sessionDir, 'data', 'observations.json');
  const tokens = estimateObservationTokens(observationsPath);

  if (tokens < config.thresholdTokens) {
    return { triggered: false, reason: `below threshold (${tokens}/${config.thresholdTokens})`, observationTokens: tokens };
  }

  const now = Date.now();
  const state = throttle.get(sessionId) ?? { lastTriggerMs: 0, inFlight: false };
  if (state.inFlight) {
    return { triggered: false, reason: 'previous run still in flight', observationTokens: tokens };
  }
  const sinceLastSec = (now - state.lastTriggerMs) / 1000;
  if (sinceLastSec < config.minIntervalSeconds) {
    return { triggered: false, reason: `throttled (${Math.floor(sinceLastSec)}s < ${config.minIntervalSeconds}s)`, observationTokens: tokens };
  }

  state.lastTriggerMs = now;
  throttle.set(sessionId, state);

  log.debug(`Reflector token-trigger fires for ${sessionId}: ${tokens} observation-tokens`);
  spawnReflector(sessionDir, sessionId);

  return { triggered: true, reason: `threshold reached (${tokens} ≥ ${config.thresholdTokens})`, observationTokens: tokens };
}

/** Reset throttle for tests or manual runs. */
export function resetReflectionTriggerThrottle(sessionId?: string): void {
  if (sessionId) throttle.delete(sessionId);
  else throttle.clear();
}
