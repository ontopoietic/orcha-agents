import { describe, it, expect } from 'bun:test';
import {
  handleSourceOAuthTrigger,
  handleGoogleOAuthTrigger,
  handleSlackOAuthTrigger,
  handleMicrosoftOAuthTrigger,
} from './source-oauth.ts';
import type { SessionToolContext, CredentialManagerInterface } from '../context.ts';
import type { AuthRequest, SourceConfig } from '../types.ts';

const SOURCES: Record<string, SourceConfig> = {
  gmail: {
    id: 'gmail', name: 'Gmail', slug: 'gmail', enabled: true, provider: 'google', type: 'api',
    isAuthenticated: true,
    api: { baseUrl: 'https://gmail.googleapis.com', authType: 'oauth', googleService: 'gmail' },
  } as SourceConfig,
  slack: {
    id: 'slack', name: 'Slack', slug: 'slack', enabled: true, provider: 'slack', type: 'api',
    isAuthenticated: true,
    api: { baseUrl: 'https://slack.com/api', authType: 'oauth' },
  } as SourceConfig,
  outlook: {
    id: 'outlook', name: 'Outlook', slug: 'outlook', enabled: true, provider: 'microsoft', type: 'api',
    isAuthenticated: true,
    api: { baseUrl: 'https://graph.microsoft.com', authType: 'oauth', microsoftService: 'outlook' },
  } as SourceConfig,
  linear: {
    id: 'linear', name: 'Linear', slug: 'linear', enabled: true, provider: 'linear', type: 'mcp',
    isAuthenticated: true,
    mcp: { url: 'https://mcp.linear.app', authType: 'oauth' },
  } as SourceConfig,
};

function createCtx(opts: {
  token?: string | null;
  refreshed?: string | null;
  isAuthenticated?: boolean;
}): { ctx: SessionToolContext; authRequests: AuthRequest[]; calls: string[] } {
  const authRequests: AuthRequest[] = [];
  const calls: string[] = [];
  const credentialManager: CredentialManagerInterface = {
    hasValidCredentials: async () => !!opts.token,
    getToken: async (source) => { calls.push(`getToken:${source.workspaceId}:${source.config.slug}`); return opts.token ?? null; },
    refresh: async (source) => { calls.push(`refresh:${source.workspaceId}:${source.config.slug}`); return opts.refreshed ?? null; },
  };
  const ctx = {
    sessionId: 'session-1',
    workspacePath: '/workspaces/ws-1',
    loadSourceConfig: (slug: string) => {
      const config = SOURCES[slug];
      return config ? { ...config, isAuthenticated: opts.isAuthenticated ?? config.isAuthenticated } : null;
    },
    credentialManager,
    callbacks: { onAuthRequest: (request: AuthRequest) => authRequests.push(request) },
  } as unknown as SessionToolContext;
  return { ctx, authRequests, calls };
}

const text = (result: { content: Array<{ text: string }> }) => result.content[0]!.text;

const PROVIDER_TRIGGERS = [
  { name: 'Google', handler: handleGoogleOAuthTrigger, slug: 'gmail', type: 'oauth-google' },
  { name: 'Slack', handler: handleSlackOAuthTrigger, slug: 'slack', type: 'oauth-slack' },
  { name: 'Microsoft', handler: handleMicrosoftOAuthTrigger, slug: 'outlook', type: 'oauth-microsoft' },
] as const;

describe('provider OAuth triggers refresh before asking the user to sign in', () => {
  for (const { name, handler, slug, type } of PROVIDER_TRIGGERS) {
    it(`${name}: a valid token needs no sign-in`, async () => {
      const { ctx, authRequests, calls } = createCtx({ token: 'still-valid' });
      const result = await handler(ctx, { sourceSlug: slug });

      expect(text(result)).toBe(`Source '${slug}' is already authenticated.`);
      expect(authRequests).toHaveLength(0);
      expect(calls).toEqual([`getToken:ws-1:${slug}`]);
    });

    it(`${name}: an expired token that refreshes needs no sign-in card`, async () => {
      const { ctx, authRequests, calls } = createCtx({ token: null, refreshed: 'fresh-token' });
      const result = await handler(ctx, { sourceSlug: slug });

      expect(result.isError).toBe(false);
      expect(text(result)).toContain('refreshed successfully');
      expect(authRequests).toHaveLength(0);
      expect(calls).toEqual([`getToken:ws-1:${slug}`, `refresh:ws-1:${slug}`]);
    });

    it(`${name}: a failed refresh asks the user to sign in`, async () => {
      const { ctx, authRequests } = createCtx({ token: null, refreshed: null });
      const result = await handler(ctx, { sourceSlug: slug });

      expect(text(result)).toContain('requested');
      expect(authRequests).toHaveLength(1);
      expect(authRequests[0]).toMatchObject({ type, sourceSlug: slug, sessionId: 'session-1' });
    });

    it(`${name}: a source that needs auth skips the refresh and asks to sign in`, async () => {
      const { ctx, authRequests, calls } = createCtx({ isAuthenticated: false, refreshed: 'would-refresh' });
      await handler(ctx, { sourceSlug: slug });

      expect(calls).toEqual([]);
      expect(authRequests).toHaveLength(1);
    });
  }

  it('MCP: still refreshes before asking to sign in', async () => {
    const refreshed = createCtx({ refreshed: 'fresh-token' });
    expect(text(await handleSourceOAuthTrigger(refreshed.ctx, { sourceSlug: 'linear' }))).toContain('refreshed successfully');
    expect(refreshed.authRequests).toHaveLength(0);

    const failed = createCtx({ refreshed: null });
    await handleSourceOAuthTrigger(failed.ctx, { sourceSlug: 'linear' });
    expect(failed.calls).toEqual(['refresh:ws-1:linear']);
    expect(failed.authRequests[0]).toMatchObject({ type: 'oauth', sourceSlug: 'linear' });
  });
});
