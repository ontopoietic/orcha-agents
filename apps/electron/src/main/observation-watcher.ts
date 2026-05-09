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
import { join } from 'path'
import type { ObservationSignal } from '@craft-agent/shared/sessions'
import { getLlmConnections } from '@craft-agent/shared/config/storage'
import { getValidClaudeOAuthToken } from '@craft-agent/shared/auth/state'

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
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.log('[observation-watcher] auth: reusing CLAUDE_CODE_OAUTH_TOKEN from process.env')
    return { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN }
  }
  if (process.env.ANTHROPIC_API_KEY) {
    console.log('[observation-watcher] auth: reusing ANTHROPIC_API_KEY from process.env')
    return { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
  }
  try {
    const conns = getLlmConnections()
    console.log(`[observation-watcher] auth: ${conns.length} LLM connections in config`)
    if (conns.length === 0) return {}
    const candidate = conns.find((c) =>
      c.providerType === 'anthropic' && (c as Record<string, unknown>).authType === 'oauth'
    ) ?? conns.find((c) => c.providerType === 'anthropic')
    if (!candidate) {
      console.warn(`[observation-watcher] auth: no Anthropic connection found among [${conns.map(c => c.slug + ':' + c.providerType).join(', ')}]`)
      return {}
    }
    console.log(`[observation-watcher] auth: trying connection ${candidate.slug} (provider=${candidate.providerType})`)
    const result = await getValidClaudeOAuthToken(candidate.slug)
    if (result.accessToken) {
      console.log(`[observation-watcher] auth: got OAuth token (length=${result.accessToken.length})`)
      return { CLAUDE_CODE_OAUTH_TOKEN: result.accessToken }
    }
    console.warn(`[observation-watcher] auth: getValidClaudeOAuthToken returned no token for ${candidate.slug}`)
  } catch (err) {
    console.warn('[observation-watcher] auth: lookup threw:', err instanceof Error ? err.message : err)
  }
  return {}
}

const WATERMARK_FILE = 'observation-watermark.json'
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
}

let watcher: FSWatcher | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let currentSessionDir: string | null = null

/**
 * Read the observation watermark and compute status for the UI.
 */
function readObservationStatus(sessionDir: string): ObservationStatus | null {
  const filePath = join(sessionDir, 'meta', WATERMARK_FILE)
  if (!existsSync(filePath)) return null

  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
    if (!raw.lastObservedAt) return null

    const lastAt = new Date(raw.lastObservedAt).getTime()
    return {
      observedCount: raw.observedCount ?? 0,
      lastSignalCount: raw.lastSignalCount ?? 0,
      lastObservedAt: raw.lastObservedAt,
      elapsedMs: Date.now() - lastAt,
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
        if (filename === WATERMARK_FILE) scheduleCheck()
      })
    }
  } catch {
    // Silently ignore if directory doesn't exist
  }

  // Emit initial state if watermark exists
  const initial = readObservationStatus(sessionDir)
  if (initial) onUpdate(initial)
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
    throw new Error('CRAFT_APP_ROOT not set — cannot locate orcha-observe.ts')
  }
  const scriptPath = join(appRoot, 'scripts', 'orcha-observe.ts')
  if (!existsSync(scriptPath)) {
    throw new Error(`Observer script not found at ${scriptPath}. In packaged builds the script must be bundled as extraResource.`)
  }

  // The session under observation lives in the workspace, not the source repo.
  const workspaceRoot = resolve(sessionDir, '..', '..')
  // Eagerly fetch auth — the observer subprocess can't hit OAuth-protected
  // endpoints unless CLAUDE_CODE_OAUTH_TOKEN is in env.
  const authEnv = await resolveObserverAuthEnv()

  return new Promise((resolveOut, rejectOut) => {
    const child = spawn('npx', ['tsx', scriptPath, sessionDir], {
      cwd: appRoot, // run from source repo so node_modules/tsx resolves
      env: {
        ...process.env,
        ...authEnv,
        CRAFT_WORKSPACE_ROOT: workspaceRoot,
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

    const killer = setTimeout(() => {
      child.kill('SIGTERM')
      rejectOut(new Error('Observer script timed out after 60s'))
    }, 60_000)

    child.on('close', (code) => {
      clearTimeout(killer)
      if (code === 0) {
        resolveOut(stdout.trim() || 'Observer ran (no output).')
      } else {
        rejectOut(new Error(`Observer exited with code ${code}: ${stderr.trim() || stdout.trim()}`))
      }
    })

    child.on('error', (err) => {
      clearTimeout(killer)
      rejectOut(err)
    })
  })
}

/**
 * Run the echo-rewrite script manually for a session. Re-extracts any
 * observation whose summary mirrors its excerpt, using whichever LLM
 * auth is currently available (CLAUDE_CODE_OAUTH_TOKEN takes precedence).
 *
 * Returns stdout on success, throws on failure or auth-missing.
 */
export async function rewriteEchoes(sessionDir: string): Promise<string> {
  const { spawn } = await import('node:child_process')
  const { resolve } = await import('node:path')

  const appRoot = process.env.CRAFT_APP_ROOT
  if (!appRoot) {
    throw new Error('CRAFT_APP_ROOT not set — cannot locate rewrite script')
  }
  const scriptPath = join(appRoot, 'scripts', 'orcha-observe-rewrite-echoes.ts')
  if (!existsSync(scriptPath)) {
    throw new Error(`Rewrite script not found at ${scriptPath}.`)
  }
  const workspaceRoot = resolve(sessionDir, '..', '..')
  const authEnv = await resolveObserverAuthEnv()

  return new Promise((resolveOut, rejectOut) => {
    const child = spawn('npx', ['tsx', scriptPath, sessionDir], {
      cwd: appRoot,
      env: {
        ...process.env,
        ...authEnv,
        CRAFT_WORKSPACE_ROOT: workspaceRoot,
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

    const killer = setTimeout(() => {
      child.kill('SIGTERM')
      rejectOut(new Error('Rewrite script timed out after 5min'))
    }, 5 * 60_000)

    child.on('close', (code) => {
      clearTimeout(killer)
      if (code === 0) {
        resolveOut(stdout.trim() || 'Rewrite ran (no output).')
      } else {
        rejectOut(new Error(`Rewrite exited with code ${code}: ${stderr.trim() || stdout.trim()}`))
      }
    })

    child.on('error', (err) => {
      clearTimeout(killer)
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
    throw new Error('CRAFT_APP_ROOT not set — cannot locate orcha-reflect.ts')
  }
  const scriptPath = join(appRoot, 'scripts', 'orcha-reflect.ts')
  if (!existsSync(scriptPath)) {
    throw new Error(`Reflector script not found at ${scriptPath}.`)
  }
  const workspaceRoot = resolve(sessionDir, '..', '..')
  const authEnv = await resolveObserverAuthEnv()

  return new Promise((resolveOut, rejectOut) => {
    const child = spawn('npx', ['tsx', scriptPath, sessionDir], {
      cwd: appRoot,
      env: {
        ...process.env,
        ...authEnv,
        CRAFT_WORKSPACE_ROOT: workspaceRoot,
        ...(options.force ? { ORCHA_REFLECT_FORCE: '1' } : {}),
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

/**
 * Read all observations for a session. Returns [] if the file does not
 * exist or is malformed (best-effort — the UI should still render).
 */
export function readObservationsList(sessionDir: string): ObservationSignal[] {
  const filePath = join(sessionDir, 'data', 'observations.json')
  if (!existsSync(filePath)) return []

  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
    const arr = Array.isArray(raw) ? raw : raw.signals
    if (!Array.isArray(arr)) return []
    return arr as ObservationSignal[]
  } catch {
    return []
  }
}
