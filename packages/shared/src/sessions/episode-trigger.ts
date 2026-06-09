/**
 * Episode Trigger — fire-and-forget spawn of orcha-episode-emit.ts.
 *
 * Phase A of memory-architecture-redesign. Called by SessionManager when
 * a phase boundary occurs (status='done', anchors changed). The actual
 * episode write happens in a detached subprocess so the UI/agent are
 * never blocked.
 *
 * Env vars:
 *   ORCHA_EPISODE_DISABLE_TRIGGER  "1" to opt out
 *
 * Throttling: per-session in-memory cooldown (5s). Anchor-change events
 * can rapid-fire from UI — the cooldown coalesces them so we don't spawn
 * three emits when the user picks a feature, then a befund, then re-picks.
 */

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { EpisodeCloseReason } from './episode.ts';
import { createLogger } from '../utils/debug.ts';

const log = createLogger('episode-trigger');

interface ThrottleState {
  lastTriggerMs: number;
  inFlight: boolean;
}

const throttle = new Map<string, ThrottleState>();
const COOLDOWN_MS = 5_000;
const KILL_TIMEOUT_MS = 60_000;

export interface TriggerEpisodeResult {
  triggered: boolean;
  reason: string;
}

export function maybeTriggerEpisode(
  sessionDir: string,
  sessionId: string,
  closeReason: EpisodeCloseReason,
): TriggerEpisodeResult {
  if (process.env.ORCHA_EPISODE_DISABLE_TRIGGER === '1') {
    return { triggered: false, reason: 'disabled by ORCHA_EPISODE_DISABLE_TRIGGER' };
  }
  if (!existsSync(sessionDir)) {
    return { triggered: false, reason: 'session dir does not exist' };
  }

  const appRoot = process.env.CRAFT_APP_ROOT;
  if (!appRoot) {
    log.debug('CRAFT_APP_ROOT not set — cannot spawn episode emitter');
    return { triggered: false, reason: 'CRAFT_APP_ROOT not set' };
  }
  const scriptPath = join(appRoot, 'scripts', 'orcha-episode-emit.ts');
  if (!existsSync(scriptPath)) {
    log.debug(`Episode emitter script not found at ${scriptPath}`);
    return { triggered: false, reason: 'emit script not found' };
  }

  const now = Date.now();
  const state = throttle.get(sessionId) ?? { lastTriggerMs: 0, inFlight: false };
  if (state.inFlight) {
    return { triggered: false, reason: 'previous run still in flight' };
  }
  if (now - state.lastTriggerMs < COOLDOWN_MS) {
    return { triggered: false, reason: 'cooldown active' };
  }
  state.lastTriggerMs = now;
  state.inFlight = true;
  throttle.set(sessionId, state);

  const child = spawn('npx', ['tsx', scriptPath, sessionDir, closeReason], {
    cwd: appRoot,
    env: { ...process.env },
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
      log.debug(`Episode emit ok for ${sessionId} (${closeReason}): ${stdout.trim().slice(0, 200)}`);
    } else if (code === 2) {
      log.debug(`Episode emit no-op for ${sessionId} (${closeReason}): nothing new to emit`);
    } else {
      log.debug(`Episode emit failed for ${sessionId} (${closeReason}, code ${code}): ${stderr.trim().slice(0, 200) || stdout.trim().slice(0, 200)}`);
    }
  });

  child.on('error', (err) => {
    state.inFlight = false;
    log.debug(`Episode emit spawn error for ${sessionId}: ${err.message}`);
  });

  setTimeout(() => {
    if (state.inFlight) {
      child.kill('SIGTERM');
      state.inFlight = false;
      log.debug(`Episode emit killed for ${sessionId} (${KILL_TIMEOUT_MS}ms timeout)`);
    }
  }, KILL_TIMEOUT_MS);

  return { triggered: true, reason: `spawned with reason=${closeReason}` };
}

/** Test/debug helper: clear cooldown for a session. */
export function resetEpisodeTriggerThrottle(sessionId?: string): void {
  if (sessionId) throttle.delete(sessionId);
  else throttle.clear();
}
