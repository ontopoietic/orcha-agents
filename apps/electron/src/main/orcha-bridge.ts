/**
 * Orcha CLI Bridge
 *
 * Resolves the local `orcha` binary, invokes its list commands, and shapes
 * the JSON output into AnchorableItem objects for the anchor picker UI.
 *
 * Caches results per (type, workingDir) for ~30s to keep the picker snappy
 * without staleness becoming a problem. The cache is invalidated on demand
 * via clearAnchorablesCache().
 *
 * Network/IO is fenced behind execFile with a 5s timeout. Failures degrade
 * gracefully: returns an empty list and logs the reason, so the picker can
 * still render an "Anchor anlegen…" hint instead of crashing.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AnchorType, AnchorableItem } from '@craft-agent/shared/sessions'
import { ANCHOR_TYPES } from '@craft-agent/shared/sessions'
import { mainLog } from './logger'

const execFileAsync = promisify(execFile)

const CACHE_TTL_MS = 30_000
const ORCHA_TIMEOUT_MS = 5_000

interface CacheEntry {
  expiresAt: number
  items: AnchorableItem[]
}

const cache = new Map<string, CacheEntry>()

function cacheKey(type: AnchorType, workingDir: string): string {
  return `${type}::${workingDir}`
}

/**
 * Resolve a path to the orcha CLI executable.
 * Tries (in order):
 *   1. ORCHA_CLI_PATH env (explicit override)
 *   2. ~/Developer/orcha/packages/cli/bin/orcha.sh (Timo's dev layout)
 *   3. `orcha` on PATH (best-effort — won't work in Finder-launched apps
 *      unless shell-env was loaded)
 *
 * Returns null when no candidate exists.
 */
export function resolveOrchaBinary(): string | null {
  const explicit = process.env.ORCHA_CLI_PATH
  if (explicit && existsSync(explicit)) return explicit

  const devLayout = join(homedir(), 'Developer/orcha/packages/cli/bin/orcha.sh')
  if (existsSync(devLayout)) return devLayout

  // Last resort: trust PATH and let execFile resolve it.
  // Will fail with ENOENT if `orcha` is not on PATH.
  return 'orcha'
}

/**
 * Shape arbitrary JSON output from `orcha {type} list` into AnchorableItem[].
 * Pure function — no IO, fully testable.
 *
 * Schema accommodation:
 *   - feature: nested {areas[].features[]} with `name`
 *   - befund: flat [{title, category, status}]
 *   - anliegen: flat [{rawText | title}]
 *
 * Unknown shapes degrade to empty list rather than throwing.
 */
export function parseAnchorables(type: AnchorType, raw: unknown): AnchorableItem[] {
  if (!Array.isArray(raw)) return []

  const items: AnchorableItem[] = []

  switch (type) {
    case 'feature': {
      // Areas at top level, each with features[]
      for (const area of raw) {
        if (!isRecord(area)) continue
        const features = area.features
        if (!Array.isArray(features)) continue
        const areaName = strField(area, 'name')
        for (const f of features) {
          if (!isRecord(f)) continue
          const id = strField(f, 'id')
          const name = strField(f, 'name')
          if (!id || !name) continue
          items.push({
            type: 'feature',
            id,
            title: name,
            subtitle: areaName ? `${areaName} · ${strField(f, 'priority') ?? 'feature'}` : strField(f, 'priority') ?? undefined,
          })
        }
      }
      break
    }
    case 'befund': {
      for (const b of raw) {
        if (!isRecord(b)) continue
        const id = strField(b, 'id')
        const title = strField(b, 'title')
        if (!id || !title) continue
        const category = strField(b, 'category')
        const status = strField(b, 'status')
        const subtitle = [category, status].filter(Boolean).join(' · ') || undefined
        items.push({ type: 'befund', id, title, subtitle })
      }
      break
    }
    case 'anliegen': {
      for (const a of raw) {
        if (!isRecord(a)) continue
        const id = strField(a, 'id')
        // anliegen carries rawText (CamelCase) or raw_text (snake) as primary title
        const title =
          strField(a, 'rawText') ?? strField(a, 'raw_text') ?? strField(a, 'title')
        if (!id || !title) continue
        const status = strField(a, 'status')
        const form = strField(a, 'form')
        const subtitle = [form, status].filter(Boolean).join(' · ') || undefined
        items.push({ type: 'anliegen', id, title: truncate(title, 80), subtitle })
      }
      break
    }
  }

  return items
}

/**
 * Invoke `orcha {type} list` in the given workingDir and return parsed
 * AnchorableItems. Cached for CACHE_TTL_MS per (type, workingDir).
 *
 * On any failure (binary missing, non-zero exit, invalid JSON) returns []
 * and logs the reason. Picker callers should treat empty as "no anchors
 * available right now", not as "no anchors exist".
 */
export async function listAnchorables(
  type: AnchorType,
  workingDir: string,
): Promise<AnchorableItem[]> {
  if (!ANCHOR_TYPES.includes(type)) {
    mainLog.warn(`[orcha-bridge] invalid anchor type: ${type}`)
    return []
  }

  const key = cacheKey(type, workingDir)
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && hit.expiresAt > now) {
    return hit.items
  }

  const binary = resolveOrchaBinary()
  if (!binary) {
    mainLog.warn('[orcha-bridge] orcha binary not found')
    return []
  }

  let stdout: string
  try {
    const result = await execFileAsync(binary, [type, 'list'], {
      cwd: workingDir,
      timeout: ORCHA_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: process.env,
    })
    stdout = result.stdout
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    mainLog.warn(`[orcha-bridge] orcha ${type} list failed: ${msg}`)
    // Cache the empty result for a short window to avoid hammering on hard
    // failures (e.g., binary missing on every picker open).
    cache.set(key, { items: [], expiresAt: now + 5_000 })
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (err) {
    mainLog.warn(`[orcha-bridge] orcha ${type} list produced non-JSON output`)
    cache.set(key, { items: [], expiresAt: now + 5_000 })
    return []
  }

  const items = parseAnchorables(type, parsed)
  cache.set(key, { items, expiresAt: now + CACHE_TTL_MS })
  return items
}

/**
 * Clear the orcha-bridge cache. Used when the user explicitly wants fresh
 * data (e.g., "Refresh" button in the picker), or when a session anchor
 * has been newly created via the CLI from this app.
 */
export function clearAnchorablesCache(type?: AnchorType, workingDir?: string): void {
  if (!type && !workingDir) {
    cache.clear()
    return
  }
  if (type && workingDir) {
    cache.delete(cacheKey(type, workingDir))
    return
  }
  // Partial wildcard: filter by whichever was provided.
  for (const key of cache.keys()) {
    const [keyType, keyDir] = key.split('::')
    if (type && keyType !== type) continue
    if (workingDir && keyDir !== workingDir) continue
    cache.delete(key)
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function strField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1).trimEnd() + '…'
}
