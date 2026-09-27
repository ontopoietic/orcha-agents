/**
 * Fork (Orcha Agents): agent-facing docs paths derive from CONFIG_DIR instead
 * of upstream's hardcoded `~/.craft-agent` (FORK.md §3).
 */
import { describe, it, expect } from 'bun:test'
import { homedir } from 'os'
import { APP_ROOT, DOC_REFS, rewriteDocAppRoot } from '../index.ts'
import { CONFIG_DIR, CONFIG_DIR_DISPLAY } from '../../config/paths.ts'

describe('APP_ROOT / DOC_REFS', () => {
  it('derives APP_ROOT from CONFIG_DIR with the home dir collapsed to ~', () => {
    expect(APP_ROOT).toBe(CONFIG_DIR_DISPLAY)
    if (CONFIG_DIR.startsWith(homedir() + '/')) {
      expect(APP_ROOT).toBe('~' + CONFIG_DIR.slice(homedir().length))
    }
    expect(DOC_REFS.docsDir).toBe(`${APP_ROOT}/docs/`)
    expect(DOC_REFS.browserTools).toBe(`${APP_ROOT}/docs/browser-tools.md`)
  })
})

describe('rewriteDocAppRoot', () => {
  it('rewrites ~/.craft-agent/ path prefixes to the given app root', () => {
    const md = [
      'Config: `~/.craft-agent/workspaces/{id}/labels/config.json`',
      'Read ~/.craft-agent/docs/pages.md first.',
      '"~/.craft-agent/**"',
    ].join('\n')
    expect(rewriteDocAppRoot(md, '~/.orcha-agents')).toBe([
      'Config: `~/.orcha-agents/workspaces/{id}/labels/config.json`',
      'Read ~/.orcha-agents/docs/pages.md first.',
      '"~/.orcha-agents/**"',
    ].join('\n'))
  })

  it('leaves the craft-agent CLI name and package names untouched', () => {
    const md = 'Use `craft-agent label list` and `@craft-agent/shared/pages/data-store`.'
    expect(rewriteDocAppRoot(md, '~/.orcha-agents')).toBe(md)
  })

  it('is a no-op when the app root is the upstream default', () => {
    const md = 'See ~/.craft-agent/docs/skills.md'
    expect(rewriteDocAppRoot(md, '~/.craft-agent')).toBe(md)
  })
})
