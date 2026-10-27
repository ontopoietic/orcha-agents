import { describe, expect, it } from 'bun:test'
import { buildSessionAuthEnvOverrides } from '../session-auth-env.ts'
import { buildClaudeSubprocessEnv } from '../options.ts'

describe('buildSessionAuthEnvOverrides', () => {
  it('pins the OAuth token and blanks a foreign API key', () => {
    expect(buildSessionAuthEnvOverrides({ CLAUDE_CODE_OAUTH_TOKEN: 'fluxs' }))
      .toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'fluxs', ANTHROPIC_API_KEY: '' })
  })

  it('pins an API key and blanks a foreign OAuth token', () => {
    expect(buildSessionAuthEnvOverrides({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://x' }))
      .toEqual({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://x', CLAUDE_CODE_OAUTH_TOKEN: '' })
  })

  it('leaves environment-based auth untouched', () => {
    expect(buildSessionAuthEnvOverrides({})).toEqual({})
  })

  it('wins over another session token in the shared process.env', () => {
    const previous = process.env.CLAUDE_CODE_OAUTH_TOKEN
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'personal'
    try {
      const env = buildClaudeSubprocessEnv(buildSessionAuthEnvOverrides({ CLAUDE_CODE_OAUTH_TOKEN: 'fluxs' }))
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('fluxs')
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = previous
    }
  })
})
