import { describe, it, expect } from 'bun:test'
import { deriveConnectionStatus, normalizeStoredStatus } from '../source-connection-status'
import type { SourceConnectionStatus } from '../../../../shared/types'

const withStatus = (connectionStatus: string) =>
  ({ config: { type: 'mcp', mcp: { authType: 'none' }, connectionStatus: connectionStatus as SourceConnectionStatus } })

describe('normalizeStoredStatus', () => {
  it('keeps the app statuses', () => {
    for (const s of ['connected', 'needs_auth', 'failed', 'untested', 'local_disabled']) {
      expect(normalizeStoredStatus(s)).toBe(s as SourceConnectionStatus)
    }
  })

  it("maps source_test's vocabulary onto the app's", () => {
    expect(normalizeStoredStatus('error')).toBe('failed')
    expect(normalizeStoredStatus('disconnected')).toBe('failed')
    expect(normalizeStoredStatus('unknown')).toBe('untested')
    expect(normalizeStoredStatus('something-new')).toBe('untested')
  })
})

describe('deriveConnectionStatus', () => {
  it('reports a failed source_test as failed, not healthy', () => {
    expect(deriveConnectionStatus(withStatus('error'))).toBe('failed')
  })

  it('still derives from auth when nothing was stored', () => {
    expect(deriveConnectionStatus({ config: { type: 'api', api: { authType: 'bearer' }, isAuthenticated: false } })).toBe('needs_auth')
    expect(deriveConnectionStatus({ config: { type: 'mcp', mcp: { authType: 'none' } } })).toBe('connected')
  })

  it('reports disabled local MCP servers before any stored status', () => {
    expect(deriveConnectionStatus({ config: { type: 'mcp', mcp: { transport: 'stdio' }, connectionStatus: 'connected' } }, false)).toBe('local_disabled')
  })
})
