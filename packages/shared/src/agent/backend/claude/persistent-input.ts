import { isStreamingModeEnabled } from '../../core/message-provider.ts';

/**
 * Pushable async-iterable input stream for the Claude SDK's streaming-input mode.
 *
 * Background (WS2): the SDK's `query({ prompt })` runs in "streaming-input mode"
 * when `prompt` is an `AsyncIterable`. As long as that iterable stays open, the
 * SDK keeps ONE subprocess/session alive across turns — which is what lets
 * background sub-agents survive past a turn's `result` (confirmed by the Phase-0
 * spike). This utility is that iterable: `push()` a user message to start/continue
 * a turn, `end()` to let the query finalize (subprocess teardown).
 *
 * Intentionally generic (no SDK import) so it is trivially unit-testable; the
 * caller instantiates it as `createPushableInputStream<SDKUserMessage>()`.
 *
 * Concurrency contract: single-consumer. Exactly one `for await` should drain
 * `.stream`. `push()`/`end()` may be called from any async context; items are
 * delivered in FIFO order and none are dropped.
 */
/**
 * Single source of truth for the WS2 keep-alive flag, so `ClaudeAgent` and
 * `SessionManager` can never drift.
 *
 * `CRAFT_KEEP_BG_AGENTS_ALIVE`:
 *   - `'1'` / `'true'`  → ON  (persistent streaming-input query)
 *   - `'0'` / `'false'` → OFF (per-turn query — kill-switch)
 *   - unset             → the DEFAULT below
 *
 * Default is now **ON** (opt-out): the persistent-query mechanism (WS2 Phase 2+),
 * the renderer keep-alive signal (`complete.backgroundTasksAlive`), and idle
 * completion-surfacing have all landed, so background sub-agents genuinely survive
 * across turns and `list_background_tasks` stays honest. Set
 * `CRAFT_KEEP_BG_AGENTS_ALIVE=0` to fall back to the per-turn kill-switch.
 *
 * ORCHA §bg-child-sessions p6 — the effective value ALSO folds in streaming
 * mode: under streaming, in-query background subagents are rerouted to
 * independent child sessions (see claude-agent.ts's class-level comment), so
 * there is nothing left for a persistent per-session query to keep alive, and
 * `markOrphanedBackgroundTasks` must be free to flip stale entries to
 * `orphaned` instead of trusting a keep-alive that no longer applies. This
 * combination used to be recomputed separately in `claude-agent.ts` (which
 * ANDed in `!isStreamingModeEnabled()`) while `SessionManager` read the raw
 * flag — the two call sites drifted, and orphaning silently never fired under
 * streaming (production incident: tasks stuck 'running' for 3+ hours after
 * their subprocess was already torn down). Folding the combination in HERE
 * restores the "can never drift" guarantee for both call sites.
 */
const DEFAULT_KEEP_ALIVE = true;

export function resolveKeepBackgroundTasksAlive(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.CRAFT_KEEP_BG_AGENTS_ALIVE;
  const flagOn = raw === '1' || raw === 'true' ? true : raw === '0' || raw === 'false' ? false : DEFAULT_KEEP_ALIVE;
  return flagOn && !isStreamingModeEnabled(env);
}

export interface PushableInputStream<T> {
  /** The async-iterable to hand to `query({ prompt })`. Drain with a single consumer. */
  readonly stream: AsyncIterable<T>;
  /** Enqueue an item; wakes a waiting consumer. Throws if already ended. */
  push(item: T): void;
  /** Signal end-of-input; the consumer's loop returns after draining the queue. */
  end(): void;
  /** Whether `end()` has been called. */
  readonly isEnded: boolean;
}

export function createPushableInputStream<T>(): PushableInputStream<T> {
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  let ended = false;

  const wakeConsumer = () => {
    const w = wake;
    wake = null;
    w?.();
  };

  async function* generator(): AsyncGenerator<T> {
    while (true) {
      // Drain everything currently queued before considering suspension, so a
      // burst of synchronous pushes is delivered in order without gaps.
      while (queue.length > 0) {
        yield queue.shift() as T;
      }
      if (ended) return;
      // Nothing queued and not ended → suspend until push()/end() wakes us.
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }

  return {
    stream: generator(),
    push(item: T): void {
      if (ended) {
        throw new Error('PushableInputStream: cannot push() after end()');
      }
      queue.push(item);
      wakeConsumer();
    },
    end(): void {
      if (ended) return;
      ended = true;
      wakeConsumer();
    },
    get isEnded(): boolean {
      return ended;
    },
  };
}
