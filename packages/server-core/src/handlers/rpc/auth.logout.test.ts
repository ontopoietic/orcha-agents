import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SecureStorageBackend } from '@craft-agent/shared/credentials/backends/secure-storage'
import { performLogout } from './auth'

/**
 * Fork (Orcha Agents): logout must only clear THIS app's credentials and
 * CONFIG_DIR/config.json — never the original app's ~/.craft-agent.
 */
describe('performLogout scope', () => {
  let root: string
  let configDir: string
  let legacyDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orcha-logout-'))
    configDir = join(root, '.orcha-agents')
    legacyDir = join(root, '.craft-agent')
    mkdirSync(configDir, { recursive: true })
    mkdirSync(legacyDir, { recursive: true })
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('clears Orcha credentials + config.json, leaves the original app untouched', async () => {
    const orcha = new SecureStorageBackend({ dir: configDir })
    const craft = new SecureStorageBackend({ dir: legacyDir })
    await orcha.set({ type: 'anthropic_api_key' } as any, { value: 'orcha' } as any)
    await craft.set({ type: 'anthropic_api_key' } as any, { value: 'craft' } as any)
    writeFileSync(join(configDir, 'config.json'), '{"orcha":true}')
    writeFileSync(join(legacyDir, 'config.json'), '{"craft":true}')
    const craftCredsBefore = readFileSync(join(legacyDir, 'credentials.enc'))

    await performLogout({ credentialManager: orcha, configDir })

    expect(await orcha.list()).toEqual([])
    expect(existsSync(join(configDir, 'config.json'))).toBe(false)

    expect(readFileSync(join(legacyDir, 'config.json'), 'utf-8')).toBe('{"craft":true}')
    expect(readFileSync(join(legacyDir, 'credentials.enc')).equals(craftCredsBefore)).toBe(true)
    const fresh = new SecureStorageBackend({ dir: legacyDir })
    expect((await fresh.get({ type: 'anthropic_api_key' } as any))?.value).toBe('craft')
  })

  it('tolerates a missing config.json', async () => {
    const orcha = new SecureStorageBackend({ dir: configDir })
    await performLogout({ credentialManager: orcha, configDir })
    expect(existsSync(join(configDir, 'config.json'))).toBe(false)
  })
})
