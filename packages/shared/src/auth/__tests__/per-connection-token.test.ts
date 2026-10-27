import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import * as credentials from '../../credentials/index.ts'
import * as storage from '../../config/storage.ts'
import { getValidClaudeOAuthToken, _resetRefreshMutex } from '../state.ts'

// Fork §15: every Claude OAuth connection must run on its own account. Upstream read the global
// legacy slot for all of them, so two accounts both ran on whichever signed in last.

const FUTURE = Date.now() + 3_600_000
const spies: Array<{ mockRestore(): void }> = []

function setup(perConnection: Record<string, { accessToken: string; expiresAt?: number }>, legacy: string | null, defaultSlug = 'claude-max') {
  const manager = {
    getLlmOAuth: async (slug: string) => perConnection[slug] ?? null,
    getClaudeOAuthCredentials: async () => (legacy ? { accessToken: legacy, expiresAt: FUTURE } : null),
  }
  spies.push(spyOn(credentials, 'getCredentialManager').mockImplementation(() => manager as never))
  spies.push(spyOn(storage, 'getDefaultLlmConnection').mockImplementation(() => defaultSlug))
}

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
  _resetRefreshMutex()
})

describe('getValidClaudeOAuthToken per connection', () => {
  it('returns each connection its own token, not the global one', async () => {
    setup({
      'claude-max': { accessToken: 'personal', expiresAt: FUTURE },
      'claude-max-2': { accessToken: 'fluxs', expiresAt: FUTURE },
    }, 'personal')
    expect((await getValidClaudeOAuthToken('claude-max')).accessToken).toBe('personal')
    expect((await getValidClaudeOAuthToken('claude-max-2')).accessToken).toBe('fluxs')
  })

  it('falls back to the legacy slot only for the default connection', async () => {
    setup({}, 'legacy')
    expect((await getValidClaudeOAuthToken('claude-max')).accessToken).toBe('legacy')
    expect((await getValidClaudeOAuthToken('claude-max-2')).accessToken).toBeNull()
  })
})
