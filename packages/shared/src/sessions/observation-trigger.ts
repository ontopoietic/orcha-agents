/**
 * Observation Trigger — token-aware async dispatcher
 *
 * The PreCompact hook fires only at the SDK's compaction threshold (~150k+
 * tokens). For most sessions that means the Observer never runs — and even
 * when it does, by then much of the conversation has already been compacted
 * away by the SDK before our extractor sees it.
 *
 * This module fires the Observer earlier, on a token budget the user
 * controls. Every turn the agent runs, the trigger reads the watermark and
 * the JSONL, estimates how many tokens of new conversation have accumulated,
 * and if the threshold is exceeded spawns the observer script in a detached
 * child process. The agent's turn is not blocked — the observation arrives
 * for the *next* turn at the latest.
 *
 * Throttling: a single observation cannot fire more often than
 * `minIntervalSeconds` per session. Without this, the trigger could
 * legitimately fire several times in a row when threshold is exceeded
 * during a flurry of messages.
 *
 * Env vars:
 *   ORCHA_OBSERVER_THRESHOLD_TOKENS      default 24000 (Mastra bufferActivation
 *                                        0.8 × messageTokens 30k — fire BEFORE
 *                                        the slice grows too big to chunk
 *                                        cheaply)
 *   ORCHA_OBSERVER_MIN_INTERVAL_SECONDS  default 60
 *   ORCHA_OBSERVER_DISABLE_TRIGGER       set to "1" to opt out entirely
 *
 * Resolution of the script: CRAFT_APP_ROOT (set by the Electron main
 * process). Packaged builds will need orcha-observe.ts as extraResource —
 * currently only dev mode is supported.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createLogger } from '../utils/debug.ts';

const log = createLogger('observation-trigger');

interface ThrottleState {
  lastTriggerMs: number;
  /** True while a child process is in flight; we never overlap. */
  inFlight: boolean;
}

/** Per-session throttle state, in-memory. Resets on process restart. */
const throttle = new Map<string, ThrottleState>();

interface TriggerConfig {
  thresholdTokens: number;
  minIntervalSeconds: number;
}

function resolveConfig(): TriggerConfig {
  const t = parseInt(process.env.ORCHA_OBSERVER_THRESHOLD_TOKENS ?? '', 10);
  const m = parseInt(process.env.ORCHA_OBSERVER_MIN_INTERVAL_SECONDS ?? '', 10);
  return {
    thresholdTokens: Number.isFinite(t) && t > 0 ? t : 24_000,
    minIntervalSeconds: Number.isFinite(m) && m >= 0 ? m : 60,
  };
}

/**
 * Approximate token count from byte size. We use file stat for the JSONL
 * and subtract the byte-offset of the watermark line. chars/4 is a coarse
 * but acceptable estimator for English+German mixed prose; the trigger is
 * a threshold heuristic, not a billing meter.
 */
function estimateTokensSinceWatermark(jsonlPath: string, lastMessageId: string | null): number {
  if (!existsSync(jsonlPath)) return 0;
  let bytes = 0;
  try {
    bytes = statSync(jsonlPath).size;
  } catch {
    return 0;
  }
  if (bytes === 0) return 0;

  // No watermark yet → estimate the full conversation so the first run
  // happens once we cross the threshold.
  if (!lastMessageId) {
    return Math.floor(bytes / 4);
  }

  // Find the byte offset of the line containing lastMessageId. Streaming
  // would be cleaner; for typical session sizes (≤ a few MB) reading the
  // file once is fine.
  try {
    const raw = readFileSync(jsonlPath, 'utf-8');
    // Search for the id surrounded by JSON quotes — substring match is
    // good enough; ids are random-looking and collision is unrealistic.
    const needle = `"${lastMessageId}"`;
    const idx = raw.indexOf(needle);
    if (idx < 0) {
      // Watermark message no longer in jsonl (rotation? truncation?) — be
      // conservative and estimate full file. Worst case we trigger sooner.
      return Math.floor(raw.length / 4);
    }
    // Find the end-of-line for that match — characters after that newline
    // are the new content.
    const newlineIdx = raw.indexOf('\n', idx);
    if (newlineIdx < 0) return 0; // watermark is on the last line
    const newCharCount = raw.length - newlineIdx - 1;
    return Math.floor(newCharCount / 4);
  } catch {
    return 0;
  }
}

interface Watermark {
  lastObservedMessageId?: string;
}

function readWatermarkLastId(sessionDir: string): string | null {
  const wmPath = join(sessionDir, 'meta', 'observation-watermark.json');
  if (!existsSync(wmPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(wmPath, 'utf-8')) as Watermark;
    return typeof raw.lastObservedMessageId === 'string' ? raw.lastObservedMessageId : null;
  } catch {
    return null;
  }
}

/**
 * Spawn the observer script for a session in a detached child process.
 * Returns once the process is started — does NOT wait for completion.
 */
function spawnObserver(sessionDir: string, sessionId: string): void {
  const appRoot = process.env.CRAFT_APP_ROOT;
  if (!appRoot) {
    log.debug('CRAFT_APP_ROOT not set — cannot spawn observer');
    return;
  }
  const scriptPath = join(appRoot, 'scripts', 'orcha-observe.ts');
  if (!existsSync(scriptPath)) {
    log.debug(`Observer script not found at ${scriptPath}`);
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
    // Slice generously — when the LLM path falls back to pattern matching
    // the diagnostic 'Sample: ...' or exception stack lives past 200 chars.
    if (code === 0) {
      log.debug(`Observer (token-trigger) ran for ${sessionId}: ${stdout.trim().slice(0, 800)}`);
      if (stderr.trim().length > 0) {
        log.debug(`Observer (token-trigger) stderr for ${sessionId}: ${stderr.trim().slice(0, 800)}`);
      }
    } else {
      log.debug(`Observer (token-trigger) failed for ${sessionId} (code ${code}): stderr=${stderr.trim().slice(0, 800)} stdout=${stdout.trim().slice(0, 400)}`);
    }
  });

  child.on('error', (err) => {
    state.inFlight = false;
    log.debug(`Observer (token-trigger) spawn error for ${sessionId}: ${err.message}`);
  });

  // Kill switch — observer should never run longer than 60s.
  setTimeout(() => {
    if (state.inFlight) {
      child.kill('SIGTERM');
      state.inFlight = false;
      log.debug(`Observer (token-trigger) killed for ${sessionId} (60s timeout)`);
    }
  }, 60_000);
}

/**
 * Decide whether to fire the observer for this session, and if so, spawn it.
 * Fire-and-forget — the caller does not await this. Safe to call on every
 * turn.
 *
 * Returns the decision so callers (or tests) can introspect.
 */
export function maybeTriggerObserver(
  sessionDir: string,
  sessionId: string,
): { triggered: boolean; reason: string; tokensSinceWatermark: number } {
  if (process.env.ORCHA_OBSERVER_DISABLE_TRIGGER === '1') {
    return { triggered: false, reason: 'disabled by ORCHA_OBSERVER_DISABLE_TRIGGER', tokensSinceWatermark: 0 };
  }
  if (!existsSync(sessionDir)) {
    return { triggered: false, reason: 'session dir does not exist', tokensSinceWatermark: 0 };
  }

  const config = resolveConfig();
  const jsonlPath = join(sessionDir, 'session.jsonl');
  const lastId = readWatermarkLastId(sessionDir);
  const tokens = estimateTokensSinceWatermark(jsonlPath, lastId);

  if (tokens < config.thresholdTokens) {
    return { triggered: false, reason: `below threshold (${tokens}/${config.thresholdTokens})`, tokensSinceWatermark: tokens };
  }

  // Throttle
  const now = Date.now();
  const state = throttle.get(sessionId) ?? { lastTriggerMs: 0, inFlight: false };
  if (state.inFlight) {
    return { triggered: false, reason: 'previous run still in flight', tokensSinceWatermark: tokens };
  }
  const sinceLastSec = (now - state.lastTriggerMs) / 1000;
  if (sinceLastSec < config.minIntervalSeconds) {
    return { triggered: false, reason: `throttled (${Math.floor(sinceLastSec)}s < ${config.minIntervalSeconds}s)`, tokensSinceWatermark: tokens };
  }

  state.lastTriggerMs = now;
  throttle.set(sessionId, state);

  log.debug(`Token-trigger fires for ${sessionId}: ${tokens} tokens since watermark`);
  spawnObserver(sessionDir, sessionId);

  return { triggered: true, reason: `threshold reached (${tokens} ≥ ${config.thresholdTokens})`, tokensSinceWatermark: tokens };
}

/**
 * Reset throttle state for a session — useful for tests or when the
 * observer is run manually and we want to skip the cooldown.
 */
export function resetTriggerThrottle(sessionId?: string): void {
  if (sessionId) throttle.delete(sessionId);
  else throttle.clear();
}
