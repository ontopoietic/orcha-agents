/**
 * Client side of source sign-in, shared by the Electron preload and the WebUI adapter.
 *
 * The server runs one OAuth flow per workspace and source (handlers/rpc/oauth.ts). A client
 * that asks while that flow is live gets `{ joined: true, flowId }` from oauth:start, opens no
 * browser, and waits here until the flow ends. One sign-in then answers every session waiting
 * on the source.
 */

export interface SourceOAuthArgs {
  sourceSlug: string
  sessionId?: string
  authRequestId?: string
  /** Replace the live sign-in for this source (its browser window was closed or lost) */
  restart?: boolean
}

export interface SourceOAuthResult {
  success: boolean
  error?: string
  email?: string
}

export type OAuthStartResult =
  | { joined: true; flowId: string; expiresInMs?: number }
  | { joined?: undefined; authUrl: string; state: string; flowId: string; expiresInMs?: number }

type Invoke = (channel: string, ...args: any[]) => Promise<any>

/** Flow lifetime when the server doesn't report one (its flow store keeps flows 5 minutes). */
export const DEFAULT_OAUTH_FLOW_TTL_MS = 5 * 60 * 1000
const POLL_INTERVAL_MS = 2_000

export const SIGN_IN_RESTARTED: SourceOAuthResult = { success: false, error: 'A new sign-in replaced this one.' }
export const SIGN_IN_TIMED_OUT: SourceOAuthResult = { success: false, error: 'The sign-in timed out. Try again.' }

/**
 * One sign-in per card at a time: a repeat call for the same source and card (a double click)
 * shares the running one, and a restart abandons every sign-in this client runs for the source.
 * `run` starts synchronously, so a browser can still open a window within the click.
 */
export function createSignInRunner(
  run: (args: SourceOAuthArgs, signal: AbortSignal) => Promise<SourceOAuthResult>,
): (args: SourceOAuthArgs) => Promise<SourceOAuthResult> {
  const running = new Map<string, { sourceSlug: string; promise: Promise<SourceOAuthResult>; abort: () => void }>()
  return (args) => {
    const key = [args.sourceSlug, args.sessionId ?? '', args.authRequestId ?? ''].join('\u0000')
    const current = running.get(key)
    if (current && !args.restart) return current.promise
    if (args.restart) {
      for (const signIn of running.values()) {
        if (signIn.sourceSlug === args.sourceSlug) signIn.abort()
      }
    }
    const controller = new AbortController()
    const promise = run(args, controller.signal).finally(() => {
      if (running.get(key)?.promise === promise) running.delete(key)
    })
    running.set(key, { sourceSlug: args.sourceSlug, promise, abort: () => controller.abort() })
    return promise
  }
}

/**
 * Wait until a flow this client joined ends and report how it ended. Gives up when the flow's
 * lifetime runs out or `signal` aborts (the user restarted the sign-in).
 */
export async function waitForJoinedOAuthFlow(
  invoke: Invoke,
  flowId: string,
  opts: { timeoutMs: number; signal?: AbortSignal; pollIntervalMs?: number },
): Promise<SourceOAuthResult> {
  const deadline = Date.now() + opts.timeoutMs
  const interval = opts.pollIntervalMs ?? POLL_INTERVAL_MS
  while (Date.now() < deadline) {
    await sleep(Math.min(interval, deadline - Date.now()), opts.signal)
    if (opts.signal?.aborted) return SIGN_IN_RESTARTED
    try {
      const status = await invoke('oauth:status', { flowId })
      if (!status.live) return status.outcome ?? { success: false, error: 'The sign-in ended without completing.' }
    } catch {
      // Transport hiccup: keep waiting until the deadline
    }
  }
  return SIGN_IN_TIMED_OUT
}

function sleep(ms: number, signal?: AbortSignal): Promise<null> {
  return raceDeadline(new Promise<never>(() => {}), ms, signal)
}

/** Settle with `promise`'s value, or null once `timeoutMs` passes or `signal` aborts. */
export function raceDeadline<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T | null> {
  if (signal?.aborted) return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const settle = (finish: () => void) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      finish()
    }
    const onAbort = () => settle(() => resolve(null))
    const timer = setTimeout(onAbort, Math.max(0, timeoutMs))
    signal?.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => settle(() => resolve(value)),
      error => settle(() => reject(error)),
    )
  })
}
