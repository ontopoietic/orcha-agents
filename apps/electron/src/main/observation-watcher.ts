/**
 * Observation Watcher — Main Process
 *
 * Watches the observation-watermark.json in a session's meta/ directory.
 * Emits IPC events when the observer runs (file created or updated),
 * enabling the renderer to show a live "observed" badge.
 *
 * Pattern follows ledger-watcher.ts: directory watch + debounce.
 */

import { watch, readFileSync, existsSync } from 'fs'
import type { FSWatcher } from 'fs'
import { join, basename } from 'path'
import { estimateBacklogTokens, getObserverThresholdTokens } from '@craft-agent/shared/sessions/observation-trigger'
import { maybeTriggerReflector } from '@craft-agent/shared/sessions/reflection-trigger'
import { maybeTriggerAutoAnchor } from '@craft-agent/shared/sessions/auto-anchor-trigger'
import { resolveOrchaScript } from '@craft-agent/shared/sessions/observer-runtime'
import { getLlmConnections } from '@craft-agent/shared/config/storage'
import { getValidClaudeOAuthToken } from '@craft-agent/shared/auth/state'
import log from 'electron-log/main'

const obsLog = log.scope('observation-watcher')

/**
 * Resolve auth env vars for the observer subprocess. The observer doesn't
 * have a persistent agent attached, so we can't rely on claude-agent.ts
 * having populated process.env. Instead, look up the first Anthropic
 * OAuth connection in the user's config and fetch a fresh token from
 * the credential manager. Returns an env-overrides object suitable for
 * spreading into a spawn() options.env.
 *
 * Precedence:
 *   1. CLAUDE_CODE_OAUTH_TOKEN already in process.env (an active agent
 *      session set it) → reuse
 *   2. ANTHROPIC_API_KEY in env or config → reuse / inject
 *   3. Look up Anthropic OAuth connection → fetch token
 *   4. Empty object → script falls back to pattern matching with a warning
 */
async function resolveObserverAuthEnv(): Promise<Record<string, string>> {
  // Prefer a freshly-validated token over whatever sits in process.env.
  // Reason: ClaudeAgent sets CLAUDE_CODE_OAUTH_TOKEN once per session start
  // (with refresh), but it never re-validates between invocations. When the
  // token's TTL elapses, the stale value lingers in process.env and observer
  // subprocesses hit 401. getValidClaudeOAuthToken() self-refreshes, so we
  // ask it first and only fall back to process.env / ANTHROPIC_API_KEY when
  // no Anthropic OAuth connection is configured.
  try {
    const conns = getLlmConnections()
    if (conns.length > 0) {
      const candidate = conns.find((c) =>
        c.providerType === 'anthropic' && (c as unknown as Record<string, unknown>).authType === 'oauth'
      ) ?? conns.find((c) => c.providerType === 'anthropic')
      if (candidate) {
        obsLog.info(`auth: refreshing OAuth via connection ${candidate.slug} (provider=${candidate.providerType})`)
        const result = await getValidClaudeOAuthToken(candidate.slug)
        if (result.accessToken) {
          obsLog.info(`auth: got OAuth token (length=${result.accessToken.length})`)
          return { CLAUDE_CODE_OAUTH_TOKEN: result.accessToken }
        }
        obsLog.warn(`auth: getValidClaudeOAuthToken returned no token for ${candidate.slug}`)
      } else {
        obsLog.warn(`auth: no Anthropic connection found among [${conns.map(c => c.slug + ':' + c.providerType).join(', ')}]`)
      }
    } else {
      obsLog.info('auth: 0 LLM connections in config')
    }
  } catch (err) {
    obsLog.warn('auth: lookup threw:', err instanceof Error ? err.message : err)
  }
  // Fallback paths — only used when the OAuth-refresh path above didn't yield
  // a token (e.g. user is on API-key-only setup).
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    obsLog.info('auth: falling back to CLAUDE_CODE_OAUTH_TOKEN from process.env')
    return { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN }
  }
  if (process.env.ANTHROPIC_API_KEY) {
    obsLog.info('auth: falling back to ANTHROPIC_API_KEY from process.env')
    return { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
  }
  return {}
}

const WATERMARK_FILE = 'observation-watermark.json'
const RUNNING_MARKER = '.observer-running'
const DEBOUNCE_MS = 300

export interface ObservationStatus {
  /** Total messages observed across all runs */
  observedCount: number
  /** Signals written in the last observation run */
  lastSignalCount: number
  /** ISO timestamp of last observation */
  lastObservedAt: string
  /** How long ago the last observation happened (ms) */
  elapsedMs: number
  /** True while the orcha-observe subprocess is currently running for this session */
  running: boolean
}

let watcher: FSWatcher | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let currentSessionDir: string | null = null

/**
 * Read the observation watermark and compute status for the UI.
 * Returns a status object even when the watermark file does not yet exist
 * (e.g. first run never produced signals) — so the renderer can still
 * surface `running: true` while the very first observer invocation is in
 * flight. Returns null only when both the watermark and the running marker
 * are absent.
 */
function readObservationStatus(sessionDir: string): ObservationStatus | null {
  const filePath = join(sessionDir, 'meta', WATERMARK_FILE)
  const running = existsSync(join(sessionDir, 'meta', RUNNING_MARKER))

  if (!existsSync(filePath)) {
    return running
      ? { observedCount: 0, lastSignalCount: 0, lastObservedAt: '', elapsedMs: 0, running: true }
      : null
  }

  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
    if (!raw.lastObservedAt) {
      return running
        ? { observedCount: 0, lastSignalCount: 0, lastObservedAt: '', elapsedMs: 0, running: true }
        : null
    }

    const lastAt = new Date(raw.lastObservedAt).getTime()
    return {
      observedCount: raw.observedCount ?? 0,
      lastSignalCount: raw.lastSignalCount ?? 0,
      lastObservedAt: raw.lastObservedAt,
      elapsedMs: Date.now() - lastAt,
      running,
    }
  } catch {
    return null
  }
}

/**
 * Start watching observation state for a session directory.
 * Calls `onUpdate` whenever the watermark file changes.
 */
export function startObservationWatch(
  sessionDir: string,
  onUpdate: (status: ObservationStatus) => void,
): void {
  stopObservationWatch()
  currentSessionDir = sessionDir

  const metaDir = join(sessionDir, 'meta')
  const scheduleCheck = () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      if (!currentSessionDir) return
      const status = readObservationStatus(currentSessionDir)
      if (status) onUpdate(status)
    }, DEBOUNCE_MS)
  }

  // Watch the meta directory (may not exist yet)
  try {
    if (!existsSync(metaDir)) {
      // If meta/ doesn't exist yet, watch the session dir for meta/ creation
      watcher = watch(sessionDir, (_eventType, filename) => {
        if (filename === 'meta') scheduleCheck()
      })
    } else {
      watcher = watch(metaDir, (_eventType, filename) => {
        if (filename === WATERMARK_FILE || filename === RUNNING_MARKER) scheduleCheck()
      })
    }
  } catch {
    // Silently ignore if directory doesn't exist
  }

  // Emit initial state if watermark exists
  const initial = readObservationStatus(sessionDir)
  if (initial) onUpdate(initial)

  // Wake-trigger (P1): the per-turn observer trigger only fires when the user
  // sends a new message. A session that ended on a long autonomous tool-loop
  // (or was simply left open) accumulates an un-observed backlog that never
  // gets processed until the next user turn — under streaming replacement that
  // means a large, stale conversation tail. On session-open, if the backlog
  // already exceeds the observer threshold and no run is in flight, fire the
  // observer once to catch up. Fire-and-forget; errors are logged, not thrown.
  maybeWakeObserver(sessionDir)
  // Same quiescent-backlog gap for the L2 Reflector and the auto-anchor pass:
  // their per-turn triggers only fire on a new turn, so a session that crossed
  // a threshold and was then left idle never catches up until reused. Wake both
  // on session-open. Both reuse the shared trigger (threshold + in-process
  // inFlight guard); we only inject fresh auth, since the watcher's process.env
  // may carry a stale/absent OAuth token.
  maybeWakeReflector(sessionDir)
  maybeWakeAutoAnchor(sessionDir)
}

/**
 * Fire the L2 Reflector on session-open when the observation ledger already
 * crossed its condense threshold but the session went idle before the per-turn
 * trigger could fire. Delegates threshold + throttle + in-flight guarding to the
 * shared trigger; only injects fresh auth for the spawned subprocess.
 */
function maybeWakeReflector(sessionDir: string): void {
  void (async () => {
    try {
      const sessionId = basename(sessionDir)
      const authEnv = await resolveObserverAuthEnv()
      const decision = maybeTriggerReflector(sessionDir, sessionId, { envOverride: authEnv })
      if (decision.triggered) {
        obsLog.info(`wake-trigger: reflector fired on session-open — ${decision.reason}`)
      }
    } catch (err) {
      obsLog.warn(`wake-trigger: reflector wake threw: ${err instanceof Error ? err.message : String(err)}`)
    }
  })()
}

/**
 * Fire the auto-anchor pass on session-open when enough observations lack a
 * framework-anchor but the session went idle. Same delegation as the reflector
 * wake. The pass is idempotent, so this is safe even alongside a per-turn run.
 */
function maybeWakeAutoAnchor(sessionDir: string): void {
  void (async () => {
    try {
      const sessionId = basename(sessionDir)
      const authEnv = await resolveObserverAuthEnv()
      const decision = maybeTriggerAutoAnchor(sessionDir, sessionId, { envOverride: authEnv })
      if (decision.triggered) {
        obsLog.info(`wake-trigger: auto-anchor fired on session-open — ${decision.reason}`)
      }
    } catch (err) {
      obsLog.warn(`wake-trigger: auto-anchor wake threw: ${err instanceof Error ? err.message : String(err)}`)
    }
  })()
}

/** Whether an observer subprocess is currently running for this session. */
function isObserverRunning(sessionDir: string): boolean {
  return existsSync(join(sessionDir, 'meta', RUNNING_MARKER))
}

/**
 * Fire the observer on session-open when a quiescent backlog has built up.
 * Guarded by the running-marker so it never overlaps an in-flight run, and by
 * the same token threshold the per-turn trigger uses, so we only spend an LLM
 * call when there is real backlog to clear.
 */
function maybeWakeObserver(sessionDir: string): void {
  try {
    if (isObserverRunning(sessionDir)) return
    const backlog = estimateBacklogTokens(sessionDir)
    const threshold = getObserverThresholdTokens()
    if (backlog < threshold) return
    obsLog.info(`wake-trigger: backlog ${backlog} ≥ ${threshold} tokens on session-open — firing observer`)
    void runObserverNow(sessionDir).catch((err) => {
      obsLog.warn(`wake-trigger: observer run failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  } catch (err) {
    obsLog.warn(`wake-trigger: backlog check threw: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Stop the active observation watcher.
 */
export function stopObservationWatch(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (watcher) {
    watcher.close()
    watcher = null
  }
  currentSessionDir = null
}

/**
 * Read observation status on demand (no watcher).
 */
export function readObservationStatusSync(sessionDir: string): ObservationStatus | null {
  return readObservationStatus(sessionDir)
}

/**
 * Run the observer script manually for a session. Returns the stdout
 * (visible to the user as feedback) or throws on spawn failure.
 *
 * The script lives in the orcha-agents source/install tree (CRAFT_APP_ROOT),
 * NOT in the user's workspace. The session it observes lives in the
 * workspace. We pass workspaceRoot via env so the script writes the
 * watermark + observations.json into the correct workspace.
 *
 * Packaged builds (app.isPackaged): orcha-observe.ts must be shipped as
 * an extraResource — currently only dev mode is supported.
 */
export async function runObserverNow(sessionDir: string): Promise<string> {
  const { spawn } = await import('node:child_process')
  const { resolve } = await import('node:path')

  // Source-repo root (dev) or app bundle root (packaged) — set in main/index.ts
  const appRoot = process.env.CRAFT_APP_ROOT
  if (!appRoot) {
    throw new Error('CRAFT_APP_ROOT not set — cannot locate orcha-observe')
  }
  const inv = resolveOrchaScript(appRoot, 'orcha-observe', [sessionDir])
  if (!inv) {
    throw new Error(`Observer script not found (neither dist/observer-scripts/orcha-observe.cjs nor scripts/orcha-observe.ts under ${appRoot}).`)
  }

  // The session under observation lives in the workspace, not the source repo.
  const workspaceRoot = resolve(sessionDir, '..', '..')
  // Eagerly fetch auth — the observer subprocess can't hit OAuth-protected
  // endpoints unless CLAUDE_CODE_OAUTH_TOKEN is in env.
  const authEnv = await resolveObserverAuthEnv()

  return new Promise((resolveOut, rejectOut) => {
    const child = spawn(inv.command, inv.args, {
      // Packaged: process.execPath (Electron-as-Node) runs the bundled CJS.
      // Dev: npx tsx resolves tsx from the source-repo node_modules.
      cwd: appRoot,
      env: {
        ...process.env,
        ...authEnv,
        CRAFT_WORKSPACE_ROOT: workspaceRoot,
        ...inv.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      const s = d.toString()
      stdout += s
      // Mirror to main-process stdout for live visibility in dev terminal
      process.stdout.write(s)
    })
    child.stderr.on('data', (d) => {
      const s = d.toString()
      stderr += s
      process.stderr.write(s)
    })

    // Must cover N chunks at Haiku-class latency. Default 4 min mirrors
    // observation-trigger.ts. Each chunk advances the watermark, so a mid-run
    // kill is self-healing on the next trigger.
    const killTimeoutMs = (() => {
      const v = parseInt(process.env.ORCHA_OBSERVER_KILL_TIMEOUT_MS ?? '', 10)
      return Number.isFinite(v) && v > 0 ? v : 240_000
    })()
    const killer = setTimeout(() => {
      child.kill('SIGTERM')
      obsLog.warn(`subprocess timed out after ${killTimeoutMs}ms; partial stdout=${stdout.trim().slice(0, 400)} stderr=${stderr.trim().slice(0, 400)}`)
      rejectOut(new Error(`Observer script timed out after ${killTimeoutMs}ms`))
    }, killTimeoutMs)

    child.on('close', (code) => {
      clearTimeout(killer)
      // ALWAYS persist subprocess output to electron-log. process.stdout
      // mirroring above only helps dev terminals; production runs lose all
      // diagnostics without this. Truncate at 1200 chars to bound noise but
      // keep the LLM-failure diagnostic sample (~400 chars) intact.
      if (stdout.trim()) {
        obsLog.info(`subprocess stdout (code=${code ?? 'null'}): ${stdout.trim().slice(0, 1200)}`)
      }
      if (stderr.trim()) {
        obsLog.warn(`subprocess stderr (code=${code ?? 'null'}): ${stderr.trim().slice(0, 1200)}`)
      }
      if (code === 0) {
        resolveOut(stdout.trim() || 'Observer ran (no output).')
      } else {
        rejectOut(new Error(`Observer exited with code ${code}: ${stderr.trim() || stdout.trim()}`))
      }
    })

    child.on('error', (err) => {
      clearTimeout(killer)
      obsLog.warn(`subprocess spawn error: ${err.message}`)
      rejectOut(err)
    })
  })
}

/**
 * Run the L2 reflector script manually. Condenses the observations.json
 * file in-place when token estimate exceeds threshold (40k by default,
 * or any size when ORCHA_REFLECT_FORCE=1 is set). Bridges high-salience
 * condensed entries to the Orcha-CLI ledger if ORCHA_LEDGER_PROJECT_DIR
 * resolves to a project directory.
 *
 * Returns stdout on success, throws on failure.
 */
export async function runReflectorNow(
  sessionDir: string,
  options: { force?: boolean } = {},
): Promise<string> {
  const { spawn } = await import('node:child_process')
  const { resolve } = await import('node:path')

  const appRoot = process.env.CRAFT_APP_ROOT
  if (!appRoot) {
    throw new Error('CRAFT_APP_ROOT not set — cannot locate orcha-reflect')
  }
  const inv = resolveOrchaScript(appRoot, 'orcha-reflect', [sessionDir])
  if (!inv) {
    throw new Error(`Reflector script not found (neither dist/observer-scripts/orcha-reflect.cjs nor scripts/orcha-reflect.ts under ${appRoot}).`)
  }
  const workspaceRoot = resolve(sessionDir, '..', '..')
  const authEnv = await resolveObserverAuthEnv()

  return new Promise((resolveOut, rejectOut) => {
    const child = spawn(inv.command, inv.args, {
      cwd: appRoot,
      env: {
        ...process.env,
        ...authEnv,
        CRAFT_WORKSPACE_ROOT: workspaceRoot,
        ...(options.force ? { ORCHA_REFLECT_FORCE: '1' } : {}),
        ...inv.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      const s = d.toString()
      stdout += s
      process.stdout.write(s)
    })
    child.stderr.on('data', (d) => {
      const s = d.toString()
      stderr += s
      process.stderr.write(s)
    })

    const killer = setTimeout(() => {
      child.kill('SIGTERM')
      rejectOut(new Error('Reflector script timed out after 5min'))
    }, 5 * 60_000)

    child.on('close', (code) => {
      clearTimeout(killer)
      if (code === 0) {
        resolveOut(stdout.trim() || 'Reflector ran (no output).')
      } else {
        rejectOut(new Error(`Reflector exited with code ${code}: ${stderr.trim() || stdout.trim()}`))
      }
    })

    child.on('error', (err) => {
      clearTimeout(killer)
      rejectOut(err)
    })
  })
}

// Ledger→signal synthesis (parsing, evidence sidecars, stable IDs, merge)
// lives in @craft-agent/shared/sessions/observation-loader (the same seam the
// reflector / episode-emit / recall scripts use) — the IPC handler in
// main/index.ts calls loadObservationSignals from there directly.
