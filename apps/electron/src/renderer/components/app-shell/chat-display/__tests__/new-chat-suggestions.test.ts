import { describe, expect, it } from 'bun:test'
import type { LoadedSource } from '@craft-agent/shared/sources/types'
import {
  newChatSuggestionKind,
  newChatSuggestionLabel,
  newChatSuggestionMessage,
  pickNewChatSuggestions,
} from '../new-chat-suggestions'

function source(slug: string, config: Record<string, unknown>): LoadedSource {
  return { config: { slug, name: slug, enabled: true, connectionStatus: 'connected', ...config } } as unknown as LoadedSource
}

const gmail = source('gmail', { name: 'Gmail', provider: 'google', type: 'api', api: { baseUrl: 'https://gmail.googleapis.com/gmail/v1/users/me/' } })
const gmail2 = source('gmail-2', { name: 'Work Gmail', provider: 'google', type: 'api', api: { baseUrl: 'https://gmail.googleapis.com/gmail/v1/users/me/' } })
const calendar = source('google-calendar', { name: 'Google Calendar', provider: 'google', type: 'api', api: { googleService: 'calendar' } })
const slack = source('slack', { name: 'Slack', provider: 'slack', type: 'api' })
const catFacts = source('cat-facts', { name: 'Cat Facts', provider: 'catfact', type: 'api' })

const fakeT = (key: string, options: { source: string }) => `${key}|${options.source}`

describe('newChatSuggestionKind', () => {
  it('splits Google and Microsoft sources by service, others by provider', () => {
    expect(newChatSuggestionKind(gmail)).toBe('email')
    expect(newChatSuggestionKind(calendar)).toBe('calendar')
    expect(newChatSuggestionKind(source('outlook', { provider: 'microsoft', api: { microsoftService: 'outlook' } }))).toBe('email')
    expect(newChatSuggestionKind(source('teams', { provider: 'microsoft', api: { microsoftService: 'teams' } }))).toBe('chat')
    expect(newChatSuggestionKind(source('todoist', { provider: 'Todoist', type: 'mcp' }))).toBe('tasks')
    expect(newChatSuggestionKind(catFacts)).toBe('source')
  })
})

describe('pickNewChatSuggestions', () => {
  it('takes one source per kind, most useful kinds first', () => {
    const picks = pickNewChatSuggestions([catFacts, slack, gmail, gmail2, calendar])
    expect(picks.map(p => [p.kind, p.sourceSlug])).toEqual([['email', 'gmail'], ['calendar', 'google-calendar'], ['chat', 'slack']])
  })

  it('skips sources that are disabled or need attention', () => {
    const picks = pickNewChatSuggestions([
      source('github', { provider: 'github', type: 'mcp', connectionStatus: 'error' }),
      source('linear', { provider: 'linear', type: 'mcp', connectionStatus: 'needs_auth' }),
      source('notion', { provider: 'notion', type: 'mcp', enabled: false }),
      source('todoist', { provider: 'todoist', type: 'mcp', connectionStatus: undefined, mcp: { authType: 'oauth' } }),
      catFacts,
    ])
    expect(picks[0]).toEqual({ kind: 'source', sourceSlug: 'cat-facts', sourceName: 'Cat Facts' })
  })

  it('tops up with prompts that need no source, offering to connect email first', () => {
    expect(pickNewChatSuggestions([])).toEqual([{ kind: 'connectEmail' }, { kind: 'news' }, { kind: 'files' }])
    expect(pickNewChatSuggestions([slack]).map(p => p.kind)).toEqual(['chat', 'connectEmail', 'news'])
    // A working email source replaces the connect offer
    expect(pickNewChatSuggestions([gmail]).map(p => p.kind)).toEqual(['email', 'news', 'files'])
    expect(pickNewChatSuggestions([gmail, slack]).map(p => p.kind)).toEqual(['email', 'chat', 'news'])
  })
})

describe('suggestion text', () => {
  it('names a workspace source in the chip and mentions it in the message', () => {
    const [pick] = pickNewChatSuggestions([gmail])
    expect(newChatSuggestionLabel(pick!, fakeT)).toBe('chat.suggestions.email|Gmail')
    expect(newChatSuggestionMessage(pick!, fakeT)).toBe('chat.suggestions.email|[source:gmail]')
  })

  it('sends a top-up as its own text', () => {
    const [pick] = pickNewChatSuggestions([])
    expect(newChatSuggestionLabel(pick!, fakeT)).toBe('chat.suggestions.connectEmail|')
    expect(newChatSuggestionMessage(pick!, fakeT)).toBe('chat.suggestions.connectEmail|')
  })
})
