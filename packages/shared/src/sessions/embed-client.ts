/**
 * Embed client — the app-side handle to the embed worker process.
 *
 * The app process (Electron main, Pi host, headless server) must never load
 * ONNX itself: on 2026-09-30 a workspace-wide recall embedded a whole
 * session's backlog in one ONNX run inside the Electron main process, the
 * allocator aborted, and the app crashed — three times in a row. This client
 * implements the `Embedder` interface by delegating to
 * `scripts/orcha-embed-worker.ts`, so:
 *   - a native failure kills only the worker; callers get an error and fall
 *     back to text scoring,
 *   - inference never blocks the app's event loop,
 *   - the model's memory lives (and is released) outside the app.
 *
 * Lifecycle: spawned lazily on first use, shut down after an idle period,
 * restarted on demand. A circuit breaker stops respawning after repeated
 * crashes so a broken model/runtime degrades to text recall instead of a
 * crash loop. `unavailable` (disabled, package missing) is sticky.
 */

import { spawn } from 'node:child_process';
import { createLogger } from '../utils/debug.ts';
import { resolveEmbedConfig, type EmbedKind, type Embedder } from './embedder.ts';
import {
  decodeWorkerLine,
  type EmbedWorkerMessage,
  type EmbedWorkerRequest,
} from './embed-protocol.ts';
import { resolveOrchaScript } from './observer-runtime.ts';

const log = createLogger('embed-client');

/** The subset of ChildProcess the client needs — lets tests inject a fake. */
export interface EmbedWorkerProcess {
  stdin: { write(chunk: string): boolean; end(): void; on(event: 'error', cb: (err: Error) => void): unknown } | null;
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null;
  on(event: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type EmbedWorkerSpawner = () => EmbedWorkerProcess | null;

export interface EmbedClientOptions {
  spawner?: EmbedWorkerSpawner;
  /** Model load on a cold cache can take a few seconds. */
  startTimeoutMs?: number;
  /** Per embed request (a query waits at most one indexing batch). */
  requestTimeoutMs?: number;
  /** Shut the worker down after this long without activity. */
  idleShutdownMs?: number;
  /** Circuit breaker: this many crashes within `crashWindowMs` → give up. */
  maxCrashes?: number;
  crashWindowMs?: number;
  now?: () => number;
}

export type EmbedClientState = 'stopped' | 'starting' | 'ready' | 'unavailable' | 'broken';

interface Pending {
  resolve: (vectors: Float32Array[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class EmbedWorkerClient implements Embedder {
  readonly model: string;
  readonly dim: number;

  private readonly spawner: EmbedWorkerSpawner;
  private readonly startTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly idleShutdownMs: number;
  private readonly maxCrashes: number;
  private readonly crashWindowMs: number;
  private readonly now: () => number;

  private _state: EmbedClientState = 'stopped';
  private child: EmbedWorkerProcess | null = null;
  private startPromise: Promise<boolean> | null = null;
  private resolveStart: ((ok: boolean) => void) | null = null;
  private stopping = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private indexing = false;
  private crashes: number[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stdoutBuffer = '';
  private stderrTail = '';

  constructor(opts: EmbedClientOptions = {}) {
    const { model, dim } = resolveEmbedConfig();
    this.model = model;
    this.dim = dim;
    this.spawner = opts.spawner ?? defaultSpawner;
    this.startTimeoutMs = opts.startTimeoutMs ?? 30_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.idleShutdownMs = opts.idleShutdownMs ?? 10 * 60_000;
    this.maxCrashes = opts.maxCrashes ?? 3;
    this.crashWindowMs = opts.crashWindowMs ?? 10 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  get state(): EmbedClientState {
    return this._state;
  }

  /** Embed via the worker. Rejects when the worker is unavailable, crashed, or timed out. */
  async embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    if (!(await this.ensureStarted())) throw new Error(`embed worker ${this._state}`);
    const id = this.nextId++;
    return new Promise<Float32Array[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`embed worker request timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ op: 'embed', id, texts, kind });
    });
  }

  /** Fire-and-forget: have the worker bring these sessions' vector sidecars up to date. */
  requestIndex(sessionDirs: string[]): void {
    if (sessionDirs.length === 0) return;
    void this.ensureStarted().then((ok) => {
      if (!ok) return;
      this.indexing = true;
      this.send({ op: 'index', sessionDirs });
    });
  }

  /** Fire-and-forget: have the worker find and index every session with a backlog. */
  requestSweep(workspaceRoots: string[]): void {
    if (workspaceRoots.length === 0) return;
    void this.ensureStarted().then((ok) => {
      if (!ok) return;
      this.indexing = true;
      this.send({ op: 'sweep', workspaceRoots });
    });
  }

  /** Stop the worker (app quit / idle). Restartable unless unavailable/broken. */
  shutdown(): void {
    if (!this.child) return;
    this.stopping = true;
    this.send({ op: 'shutdown' });
    this.child.stdin?.end();
    const child = this.child;
    setTimeout(() => child.kill('SIGKILL'), 2_000).unref?.();
  }

  // --------------------------------------------------------------------------

  private ensureStarted(): Promise<boolean> {
    if (this._state === 'ready') return Promise.resolve(true);
    if (this._state === 'unavailable' || this._state === 'broken') return Promise.resolve(false);
    if (this.startPromise) return this.startPromise;

    let child: EmbedWorkerProcess | null;
    try {
      child = this.spawner();
    } catch (error) {
      log.debug(`spawn failed: ${error instanceof Error ? error.message : String(error)}`);
      child = null;
    }
    if (!child) {
      this._state = 'unavailable';
      return Promise.resolve(false);
    }

    this._state = 'starting';
    this.child = child;
    this.stopping = false;
    this.stdoutBuffer = '';
    this.stderrTail = '';
    this.startPromise = new Promise<boolean>((resolve) => {
      this.resolveStart = resolve;
    });
    const startTimer = setTimeout(() => {
      if (this._state === 'starting') {
        log.debug(`worker did not become ready within ${this.startTimeoutMs}ms — killing`);
        child.kill('SIGKILL');
      }
    }, this.startTimeoutMs);

    child.stdin?.on('error', () => {
      /* EPIPE after the worker died — handled by the exit event */
    });
    child.stdout?.on('data', (chunk) => this.onStdout(String(chunk)));
    child.stderr?.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-2_000);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(startTimer);
      this.onExit(child, code, signal);
    });
    return this.startPromise;
  }

  private settleStart(ok: boolean): void {
    this.resolveStart?.(ok);
    this.resolveStart = null;
    this.startPromise = null;
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let nl: number;
    while ((nl = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, nl);
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      const msg = decodeWorkerLine(line);
      if (msg) this.onMessage(msg);
    }
  }

  private onMessage(msg: EmbedWorkerMessage): void {
    this.touch();
    switch (msg.type) {
      case 'ready':
        if (msg.model !== this.model || msg.dim !== this.dim) {
          log.debug(`worker model mismatch (${msg.model}/${msg.dim} vs ${this.model}/${this.dim}) — disabling`);
          this._state = 'unavailable';
          this.settleStart(false);
          this.shutdown();
          return;
        }
        this._state = 'ready';
        this.settleStart(true);
        return;
      case 'unavailable':
        log.debug(`worker reports embedder unavailable: ${msg.reason}`);
        this._state = 'unavailable';
        this.settleStart(false);
        return;
      case 'result': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg.vectors.map((v) => Float32Array.from(v)));
        return;
      }
      case 'error': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.reject(new Error(msg.message));
        return;
      }
      case 'indexed':
        if (msg.embedded > 0) log.debug(`indexed ${msg.embedded} observation(s) in ${msg.sessionDir}`);
        return;
      case 'index-error':
        log.debug(`indexing failed for ${msg.sessionDir}: ${msg.message}`);
        return;
      case 'idle':
        this.indexing = false;
        return;
    }
  }

  private onExit(child: EmbedWorkerProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.child = null;
    this.indexing = false;
    this.clearIdleTimer();
    const intentional = this.stopping;
    this.stopping = false;

    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`embed worker exited (code=${code}, signal=${signal})`));
      this.pending.delete(id);
    }

    if (this._state === 'unavailable') {
      this.settleStart(false);
      return;
    }
    if (intentional) {
      this._state = 'stopped';
      this.settleStart(false);
      return;
    }

    const now = this.now();
    this.crashes = [...this.crashes.filter((t) => now - t < this.crashWindowMs), now];
    const tail = this.stderrTail.trim().split('\n').slice(-5).join(' | ');
    if (this.crashes.length >= this.maxCrashes) {
      this._state = 'broken';
      log.debug(
        `embed worker crashed ${this.crashes.length}x within ${this.crashWindowMs}ms — semantic recall disabled for this app session (code=${code}, signal=${signal}) ${tail}`,
      );
    } else {
      this._state = 'stopped';
      log.debug(`embed worker exited unexpectedly (code=${code}, signal=${signal}) — will restart on demand. ${tail}`);
    }
    this.settleStart(false);
  }

  private send(req: EmbedWorkerRequest): void {
    this.touch();
    try {
      this.child?.stdin?.write(`${JSON.stringify(req)}\n`);
    } catch {
      /* worker gone — exit handler rejects pending requests */
    }
  }

  private touch(): void {
    this.clearIdleTimer();
    if (!this.child) return;
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0 && !this.indexing) this.shutdown();
      else this.touch();
    }, this.idleShutdownMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

/**
 * Spawn `orcha-embed-worker` the same way the Observer scripts are spawned
 * (bundled CJS via Electron-as-Node when packaged, tsx in dev). Returns null —
 * i.e. semantic recall unavailable — when disabled or the script can't be found.
 */
const defaultSpawner: EmbedWorkerSpawner = () => {
  if (process.env.ORCHA_EMBED_DISABLE === '1') return null;
  const appRoot = process.env.CRAFT_APP_ROOT;
  if (!appRoot) return null;
  const inv = resolveOrchaScript(appRoot, 'orcha-embed-worker', []);
  if (!inv) return null;
  return spawn(inv.command, inv.args, {
    cwd: appRoot,
    env: { ...process.env, ...inv.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
};

let singleton: EmbedWorkerClient | null | undefined;

/** Process-wide client. The app's only route to embeddings. */
export function getEmbedClient(): EmbedWorkerClient {
  if (!singleton) singleton = new EmbedWorkerClient();
  return singleton;
}

/**
 * Write-time indexing: call after a successful Observer/Reflector run changed
 * a session's ledger. The worker embeds only the new texts (content-addressed
 * cache), so recall finds them without ever embedding inline.
 */
export function requestEmbeddingIndex(sessionDir: string): void {
  try {
    getEmbedClient().requestIndex([sessionDir]);
  } catch {
    // best-effort: the next recall or the startup sweep picks it up
  }
}

/** App quit: stop the worker if one is running. */
export function shutdownEmbedClient(): void {
  singleton?.shutdown();
}

/** Test seam. */
export function setEmbedClientForTesting(client: EmbedWorkerClient | null | undefined): void {
  singleton = client;
}
