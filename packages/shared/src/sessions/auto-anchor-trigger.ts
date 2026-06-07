/**
 * Auto-Anchor Trigger — auto-fires the auto-anchor pass when enough
 * observations have accumulated WITHOUT a framework-anchor, so cross-session
 * recall's precise anchor axis stays populated without hand-tagging.
 *
 * Pairs with observation-trigger.ts (L1 Observer) and reflection-trigger.ts
 * (L2 Reflector). This is the lightest of the three: it only counts how many
 * sidecar-backed observations lack anchorRefs and, past a threshold, spawns
 * scripts/orcha-recall-anchors.ts (which does the LLM tagging + sidecar write).
 *
 * Safe to run independently of the Reflector: orcha-reflect.ts preserves
 * existing anchorRefs when it rebuilds the evidence sidecar, so auto-added
 * anchors survive later reflections. The pass is idempotent (dedup by type:id),
 * so the narrow simultaneous-write window is self-healing — a dropped write is
 * simply re-applied on the next run.
 *
 * Env vars:
 *   ORCHA_AUTOANCHOR_THRESHOLD            default 8 (untagged observations)
 *   ORCHA_AUTOANCHOR_MIN_INTERVAL_SECONDS default 300
 *   ORCHA_AUTOANCHOR_DISABLE_TRIGGER      "1" to opt out entirely
 *
 * Design notes:
 * - Counts untagged entries across observations-evidence.json AND
 *   observations-evidence.mastra.json (whichever the session uses).
 * - Throttle is in-memory per session — process restarts reset it.
 * - Spawn is fire-and-forget; the agent's turn is not blocked.
 */

import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createLogger } from '../utils/debug.ts';

const log = createLogger('auto-anchor-trigger');

const SIDECAR_FILES = ['observations-evidence.json', 'observations-evidence.mastra.json'];

interface ThrottleState {
  lastTriggerMs: number;
  inFlight: boolean;
}

const throttle = new Map<string, ThrottleState>();

interface TriggerConfig {
  threshold: number;
  minIntervalSeconds: number;
}

function resolveConfig(): TriggerConfig {
  const t = parseInt(process.env.ORCHA_AUTOANCHOR_THRESHOLD ?? '', 10);
  const m = parseInt(process.env.ORCHA_AUTOANCHOR_MIN_INTERVAL_SECONDS ?? '', 10);
  return {
    threshold: Number.isFinite(t) && t > 0 ? t : 8,
    minIntervalSeconds: Number.isFinite(m) && m >= 0 ? m : 300,
  };
}

/**
 * Count sidecar-backed observations that have NO anchorRefs yet, across both
 * the legacy and Mastra evidence sidecars. Cheap (small JSON reads); safe to
 * call every turn.
 */
export function countUntaggedObservations(sessionDataDir: string): number {
  let untagged = 0;
  for (const name of SIDECAR_FILES) {
    const p = join(sessionDataDir, name);
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf-8'));
      if (!parsed || typeof parsed !== 'object') continue;
      for (const entry of Object.values(parsed as Record<string, { anchorRefs?: unknown }>)) {
        const refs = entry?.anchorRefs;
        if (!Array.isArray(refs) || refs.length === 0) untagged++;
      }
    } catch {
      /* ignore malformed sidecar */
    }
  }
  return untagged;
}

function spawnAutoAnchor(sessionDir: string, sessionId: string): void {
  const appRoot = process.env.CRAFT_APP_ROOT;
  if (!appRoot) {
    log.debug('CRAFT_APP_ROOT not set — cannot spawn auto-anchor');
    return;
  }
  const scriptPath = join(appRoot, 'scripts', 'orcha-recall-anchors.ts');
  if (!existsSync(scriptPath)) {
    log.debug(`Auto-anchor script not found at ${scriptPath}`);
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
      log.debug(`Auto-anchor ran for ${sessionId}: ${stdout.trim().slice(0, 200)}`);
    } else {
      log.debug(`Auto-anchor failed for ${sessionId} (code ${code}): ${stderr.trim().slice(0, 200) || stdout.trim().slice(0, 200)}`);
    }
  });

  child.on('error', (err) => {
    state.inFlight = false;
    log.debug(`Auto-anchor spawn error for ${sessionId}: ${err.message}`);
  });

  // Single haiku call over a session's observations — 90s is ample.
  setTimeout(() => {
    if (state.inFlight) {
      child.kill('SIGTERM');
      state.inFlight = false;
      log.debug(`Auto-anchor killed for ${sessionId} (90s timeout)`);
    }
  }, 90_000);
}

/**
 * Decide whether to fire the auto-anchor pass for this session, and if so,
 * spawn it. Fire-and-forget — safe to call on every turn.
 */
export function maybeTriggerAutoAnchor(
  sessionDir: string,
  sessionId: string,
): { triggered: boolean; reason: string; untaggedCount: number } {
  if (process.env.ORCHA_AUTOANCHOR_DISABLE_TRIGGER === '1') {
    return { triggered: false, reason: 'disabled by ORCHA_AUTOANCHOR_DISABLE_TRIGGER', untaggedCount: 0 };
  }
  if (!existsSync(sessionDir)) {
    return { triggered: false, reason: 'session dir does not exist', untaggedCount: 0 };
  }

  const config = resolveConfig();
  const untagged = countUntaggedObservations(join(sessionDir, 'data'));

  if (untagged < config.threshold) {
    return {
      triggered: false,
      reason: `below threshold (untagged ${untagged}/${config.threshold})`,
      untaggedCount: untagged,
    };
  }

  const now = Date.now();
  const state = throttle.get(sessionId) ?? { lastTriggerMs: 0, inFlight: false };
  if (state.inFlight) {
    return { triggered: false, reason: 'previous run still in flight', untaggedCount: untagged };
  }
  const sinceLastSec = (now - state.lastTriggerMs) / 1000;
  if (sinceLastSec < config.minIntervalSeconds) {
    return { triggered: false, reason: `throttled (${Math.floor(sinceLastSec)}s < ${config.minIntervalSeconds}s)`, untaggedCount: untagged };
  }

  state.lastTriggerMs = now;
  throttle.set(sessionId, state);

  log.debug(`Auto-anchor trigger fires for ${sessionId}: untagged ${untagged} ≥ ${config.threshold}`);
  spawnAutoAnchor(sessionDir, sessionId);

  return { triggered: true, reason: `threshold reached (untagged ${untagged} ≥ ${config.threshold})`, untaggedCount: untagged };
}

/** Reset throttle for tests or manual runs. */
export function resetAutoAnchorTriggerThrottle(sessionId?: string): void {
  if (sessionId) throttle.delete(sessionId);
  else throttle.clear();
}
