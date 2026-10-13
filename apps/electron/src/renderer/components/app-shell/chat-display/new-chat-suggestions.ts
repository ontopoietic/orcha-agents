/**
 * Starter prompts for a new, empty chat (design spec §7.8): up to three, drawn from the
 * workspace's working sources and topped up with prompts that need no source (connect an
 * email account, web news, the working folder). A click sends the prompt at once,
 * so every template only reads. Pure: no React, no i18n instance; `t` is passed in.
 */
import type { LoadedSource } from '@craft-agent/shared/sources/types'
import { inferGoogleServiceFromUrl, inferMicrosoftServiceFromUrl } from '@craft-agent/shared/sources/types'
import { deriveConnectionStatus } from '../../ui/source-connection-status'

/** Source kinds (prompt about one workspace source) */
type SourceSuggestionKind = 'email' | 'calendar' | 'chat' | 'tasks' | 'issues' | 'code' | 'docs' | 'source'
/** Top-up kinds (no source needed) */
type TopUpSuggestionKind = 'connectEmail' | 'news' | 'files'
export type NewChatSuggestionKind = SourceSuggestionKind | TopUpSuggestionKind

export interface NewChatSuggestion {
  kind: NewChatSuggestionKind
  /** Workspace source the prompt is about; absent for top-ups */
  sourceSlug?: string
  sourceName?: string
}

export const NEW_CHAT_SUGGESTION_COUNT = 3

/** Most useful first: one chip per kind, generic sources after these. */
const KIND_ORDER: SourceSuggestionKind[] = ['email', 'calendar', 'chat', 'tasks', 'issues', 'code', 'docs']

/** `provider` is a freeform label; these are the common ones. Google/Microsoft split by service below. */
const PROVIDER_KINDS: Record<string, SourceSuggestionKind> = {
  fastmail: 'email',
  gmail: 'email',
  outlook: 'email',
  slack: 'chat',
  discord: 'chat',
  teams: 'chat',
  todoist: 'tasks',
  asana: 'tasks',
  clickup: 'tasks',
  trello: 'tasks',
  ticktick: 'tasks',
  linear: 'issues',
  jira: 'issues',
  atlassian: 'issues',
  github: 'code',
  gitlab: 'code',
  bitbucket: 'code',
  craft: 'docs',
  notion: 'docs',
  confluence: 'docs',
  obsidian: 'docs',
}

/** Shown, in order, when the workspace has fewer than three suggestible sources. They work without any source. */
const TOP_UPS: TopUpSuggestionKind[] = ['connectEmail', 'news', 'files']

export function newChatSuggestionKind(source: LoadedSource): SourceSuggestionKind {
  const { provider, api } = source.config
  switch (provider?.toLowerCase()) {
    case 'google':
      switch (api?.googleService ?? inferGoogleServiceFromUrl(api?.baseUrl)) {
        case 'gmail': return 'email'
        case 'calendar': return 'calendar'
        case 'docs':
        case 'drive': return 'docs'
        default: return 'source'
      }
    case 'microsoft':
      switch (api?.microsoftService ?? inferMicrosoftServiceFromUrl(api?.baseUrl)) {
        case 'outlook': return 'email'
        case 'microsoft-calendar': return 'calendar'
        case 'teams': return 'chat'
        case 'onedrive':
        case 'sharepoint': return 'docs'
        default: return 'source'
      }
    default:
      return PROVIDER_KINDS[provider?.toLowerCase() ?? ''] ?? 'source'
  }
}

/** Enabled and not known to be broken: a prompt that names it should work right away. */
function isSuggestible(source: LoadedSource): boolean {
  if (source.config.enabled === false) return false
  const status = deriveConnectionStatus(source)
  return status === 'connected' || status === 'untested'
}

export function pickNewChatSuggestions(sources: readonly LoadedSource[]): NewChatSuggestion[] {
  const firstByKind = new Map<SourceSuggestionKind, LoadedSource>()
  const generic: LoadedSource[] = []
  for (const source of sources) {
    if (!isSuggestible(source)) continue
    const kind = newChatSuggestionKind(source)
    if (kind === 'source') generic.push(source)
    else if (!firstByKind.has(kind)) firstByKind.set(kind, source)
  }

  const fromSource = (kind: SourceSuggestionKind, source: LoadedSource): NewChatSuggestion =>
    ({ kind, sourceSlug: source.config.slug, sourceName: source.config.name })
  const picks: NewChatSuggestion[] = [
    ...KIND_ORDER.flatMap(kind => {
      const source = firstByKind.get(kind)
      return source ? [fromSource(kind, source)] : []
    }),
    ...generic.map(source => fromSource('source', source)),
  ].slice(0, NEW_CHAT_SUGGESTION_COUNT)

  for (const kind of TOP_UPS) {
    if (picks.length >= NEW_CHAT_SUGGESTION_COUNT) break
    // Connecting email is only offered while no email source works
    if (kind === 'connectEmail' && firstByKind.has('email')) continue
    picks.push({ kind })
  }
  return picks
}

type Translate = (key: string, options: { source: string }) => string

/** Chip text: the source by name. */
export function newChatSuggestionLabel(suggestion: NewChatSuggestion, t: Translate): string {
  return t(`chat.suggestions.${suggestion.kind}`, { source: suggestion.sourceName ?? '' })
}

/** The message sent: a workspace source as a `[source:slug]` mention (shown as its badge, enabled on send). */
export function newChatSuggestionMessage(suggestion: NewChatSuggestion, t: Translate): string {
  return t(`chat.suggestions.${suggestion.kind}`, {
    source: suggestion.sourceSlug ? `[source:${suggestion.sourceSlug}]` : (suggestion.sourceName ?? ''),
  })
}
