/**
 * Orcha Agents fork: hydrate sessions this window learns about only through
 * an agent/session event.
 *
 * Why: the `sessions:create` RPC suppresses the `session_created` broadcast
 * (the calling renderer is expected to add the session from the return value
 * via App.tsx handleCreateSession). A session created any other way — raw
 * `electronAPI.createSession()`, another window, a remote client — is unknown
 * here. The first event for it (complete, session_status_changed, …) then goes
 * through the event processor with `currentSession = null`, which builds an
 * empty stub session (no `name`) and puts it in the meta map → the list row
 * shows "New chat" even though the stored session has a name.
 *
 * Sessions from spawn_session / TaskRunner are not affected: they call
 * SessionManager.createSession() directly, which broadcasts `session_created`
 * and the renderer hydrates full metadata.
 *
 * This helper fetches the authoritative session once per unknown id.
 */

export interface UnknownSessionHydratorDeps<S extends { id: string }> {
  /** Fetch the full session from the server (electronAPI.getSessionMessages). */
  fetchSession: (sessionId: string) => Promise<S | null>
  /** Apply the authoritative session (replace stub / add). */
  applySession: (session: S) => void
  onError?: (error: unknown) => void
}

export interface UnknownSessionHydrator {
  /**
   * Call for every incoming session event. `isKnown` = this window already
   * holds the session (per-session atom or meta entry) before the event is
   * processed. Returns true when a hydrate was started.
   */
  maybeHydrate: (sessionId: string, isKnown: boolean) => boolean
}

export function createUnknownSessionHydrator<S extends { id: string }>(
  deps: UnknownSessionHydratorDeps<S>,
): UnknownSessionHydrator {
  const inFlight = new Set<string>()
  return {
    maybeHydrate(sessionId, isKnown) {
      if (isKnown || inFlight.has(sessionId)) return false
      inFlight.add(sessionId)
      deps.fetchSession(sessionId)
        .then((session) => {
          if (session) deps.applySession(session)
        })
        .catch((error: unknown) => deps.onError?.(error))
        .finally(() => inFlight.delete(sessionId))
      return true
    },
  }
}
