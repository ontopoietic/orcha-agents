/**
 * Observation Watcher — Main Process
 *
 * Watches the observation-watermark.json in a session's meta/ directory.
 * Emits IPC events when the observer runs (file created or updated),
 * enabling the renderer to show a live "observed" badge.
 *
 * Pattern follows ledger-watcher.ts: directory watch + debounce.
 */

import { watch, readFileSync, existsSync, statSync } from 'fs'
import type { FSWatcher } from 'fs'
import { join } from 'path'
import type { ObservationSignal } from '@craft-agent/shared/sessions'
import {
  parseObservationsMarkdown,
  type ParsedBullet,
} from '@craft-agent/shared/sessions/observation-markdown-parser'
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
      obsLog.warn(`subprocess timed out after 60s; partial stdout=${stdout.trim().slice(0, 400)} stderr=${stderr.trim().slice(0, 400)}`)
      rejectOut(new Error('Observer script timed out after 60s'))
    }, 60_000)

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

interface EvidenceEntry {
  fullMessageId?: string
  messageRangeTo?: string
  excerpt?: string
  actor?: 'user' | 'agent'
  createdAt?: string
  anchorRefs?: unknown[]
}

/**
 * Synthesize ObservationSignal records from a Markdown bullet ledger and
 * its evidence sidecar. Bullets without a sidecar entry still render — the
 * Markdown is the source of truth; the sidecar just enriches them.
 */
function readObservationsFromMarkdown(sessionDir: string): ObservationSignal[] | null {
  const mdPath = join(sessionDir, 'data', 'observations.md')
  if (!existsSync(mdPath)) return null
  const sidecarPath = join(sessionDir, 'data', 'observations-evidence.json')

  let bullets: ParsedBullet[] | null
  try {
    bullets = parseObservationsMarkdown(readFileSync(mdPath, 'utf-8'))
  } catch {
    return null
  }
  if (!bullets) return null

  let sidecar: Record<string, EvidenceEntry> = {}
  if (existsSync(sidecarPath)) {
    try {
      const raw = JSON.parse(readFileSync(sidecarPath, 'utf-8'))
      if (raw && typeof raw === 'object') sidecar = raw as Record<string, EvidenceEntry>
    } catch {
      sidecar = {}
    }
  }

  const result: ObservationSignal[] = []
  // Stable IDs: use anchor + bullet index so React keys don't churn across
  // re-fetches. Without this, the ObservationCard remounts on every refresh
  // and 'expanded' state resets — making "Show more" appear broken.
  const seenAnchorCounts = new Map<string, number>()
  for (let i = 0; i < bullets.length; i++) {
    const bullet = bullets[i]!
    const anchor = bullet.anchorShortId ?? 'md'
    const dupIdx = seenAnchorCounts.get(anchor) ?? 0
    seenAnchorCounts.set(anchor, dupIdx + 1)
    const evidence = bullet.anchorShortId ? sidecar[bullet.anchorShortId] : undefined
    const createdAt = evidence?.createdAt ?? deriveCreatedAt(bullet)
    result.push({
      id: `obs-${anchor}${dupIdx > 0 ? `-${dupIdx}` : ''}`,
      createdAt,
      source: 'conversation',
      summary: bullet.summary,
      status: 'raw',
      salience: bullet.salience,
      anchorRefs: evidence?.anchorRefs as ObservationSignal['anchorRefs'],
      conversation: {
        sessionId: '',
        messageRange: {
          from: evidence?.fullMessageId ?? '',
          to: evidence?.messageRangeTo ?? evidence?.fullMessageId ?? '',
        },
        excerpt: evidence?.excerpt ?? '',
        actor: evidence?.actor ?? 'agent',
      },
    })
  }
  return result
}

/** Compose an ISO timestamp from a parsed bullet's date + time if possible. */
function deriveCreatedAt(bullet: ParsedBullet): string {
  if (bullet.date && bullet.time) {
    const iso = `${bullet.date}T${bullet.time}:00`
    const d = new Date(iso)
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  }
  return new Date().toISOString()
}

/**
 * Read all observations for a session. Returns [] if the file does not
 * exist or is malformed (best-effort — the UI should still render).
 *
 * Source resolution:
 *  1. If observations.md is the newest of the two, use it (canonical post Plan A path).
 *  2. If observations.json is newer (e.g. the Reflector just ran but hasn't
 *     been migrated to write Markdown yet), use it. Keeps the UI in sync
 *     with Reflector output until Plan C lands.
 *  3. Otherwise: whichever one exists.
 */
export function readObservationsList(sessionDir: string): ObservationSignal[] {
  const mdPath = join(sessionDir, 'data', 'observations.md')
  const jsonPath = join(sessionDir, 'data', 'observations.json')
  const mdMtime = existsSync(mdPath) ? statSync(mdPath).mtimeMs : 0
  const jsonMtime = existsSync(jsonPath) ? statSync(jsonPath).mtimeMs : 0

  // If JSON is newer than MD by more than 1s, prefer JSON. The 1s tolerance
  // accounts for the dual-write in writeSignalsToLedger writing both files
  // in quick succession.
  const preferJson = jsonMtime > mdMtime + 1000

  if (!preferJson) {
    const fromMarkdown = readObservationsFromMarkdown(sessionDir)
    if (fromMarkdown && fromMarkdown.length > 0) return fromMarkdown
  }

  if (!existsSync(jsonPath)) return readObservationsFromMarkdown(sessionDir) ?? []

  const filePath = jsonPath

  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
    const arr = Array.isArray(raw) ? raw : raw.signals
    if (!Array.isArray(arr)) return []
    return arr as ObservationSignal[]
  } catch {
    return []
  }
}
