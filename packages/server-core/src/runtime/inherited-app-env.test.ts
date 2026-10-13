import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { isPathInside, resolveInheritedAppEnv, sourceCheckoutRoot } from './inherited-app-env'

const own = '/work/CraftAgentsDev/sdk-uplift-release'
const app = '/work/CraftAgentsDev/craft-agents-design-remake'

describe('resolveInheritedAppEnv', () => {
  it("ignores a running app's CRAFT_APP_ROOT and every CRAFT_* path inside it", () => {
    const env = {
      CRAFT_APP_ROOT: app,
      CRAFT_RESOURCES_BASE: `${app}/apps/electron`,
      CRAFT_UV: `${app}/apps/electron/resources/bin/darwin-arm64/uv`,
      CRAFT_CLI_ENTRY: `${app}/packages/craft-cli/src/cli.ts`,
      CRAFT_SESSION_DIR: '/work/CraftAgentWS/sessions/261010-onyx-heron',
      CRAFT_CONFIG_DIR: '',
      CRAFT_DEBUG: '1',
      PATH: `${app}/bin:/usr/bin`,
    }
    const result = resolveInheritedAppEnv(env, own, own)
    expect(result.ignoredAppRoot).toBe(app)
    expect(result.appRootPath).toBe(own)
    expect(result.dropKeys.sort()).toEqual(['CRAFT_APP_ROOT', 'CRAFT_CLI_ENTRY', 'CRAFT_RESOURCES_BASE', 'CRAFT_UV'])
  })

  it('falls back to the checkout root when the cwd is outside it', () => {
    expect(resolveInheritedAppEnv({ CRAFT_APP_ROOT: app }, own, '/tmp').appRootPath).toBe(own)
  })

  it('keeps a CRAFT_APP_ROOT inside its own checkout', () => {
    const result = resolveInheritedAppEnv({ CRAFT_APP_ROOT: `${own}/apps/electron` }, own, own)
    expect(result).toEqual({ appRootPath: `${own}/apps/electron`, dropKeys: [] })
  })

  it('honors CRAFT_APP_ROOT for bundled servers (no source checkout)', () => {
    expect(resolveInheritedAppEnv({ CRAFT_APP_ROOT: '/app' }, null, '/srv')).toEqual({ appRootPath: '/app', dropKeys: [] })
  })

  it('defaults to the cwd when CRAFT_APP_ROOT is unset', () => {
    expect(resolveInheritedAppEnv({}, own, own)).toEqual({ appRootPath: own, dropKeys: [] })
  })
})

describe('sourceCheckoutRoot', () => {
  it('finds this monorepo when server-core runs from source', () => {
    const root = sourceCheckoutRoot()
    expect(root).not.toBeNull()
    expect(isPathInside(join(root!, 'packages', 'server-core'), root!)).toBe(true)
  })

  it('returns null outside a checkout (bundled builds) or without a module folder', () => {
    expect(sourceCheckoutRoot('/a/b/c/d')).toBeNull()
    expect(sourceCheckoutRoot(null)).toBeNull()
  })
})

describe('isPathInside', () => {
  it('treats a sibling with a shared prefix as outside', () => {
    expect(isPathInside('/work/repo-2/x', '/work/repo')).toBe(false)
    expect(isPathInside('/work/repo/x', '/work/repo')).toBe(true)
    expect(isPathInside('/work/repo', '/work/repo')).toBe(true)
  })
})
