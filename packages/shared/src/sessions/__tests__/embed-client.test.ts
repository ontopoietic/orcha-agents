import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { EmbedWorkerClient, type EmbedWorkerProcess } from '../embed-client.ts';
import { decodeWorkerLine, encodeWorkerMessage, type EmbedWorkerMessage, type EmbedWorkerRequest } from '../embed-protocol.ts';
import { resolveEmbedConfig } from '../embedder.ts';

const { model: MODEL, dim: DIM } = resolveEmbedConfig();

type Behaviour = {
  /** First message after spawn (default: ready with the configured model). */
  hello?: EmbedWorkerMessage | null;
  /** How to answer an embed request; return null to stay silent. */
  onEmbed?: (req: Extract<EmbedWorkerRequest, { op: 'embed' }>, w: FakeWorker) => EmbedWorkerMessage | null;
};

/** In-memory stand-in for the worker child process, speaking the real protocol. */
class FakeWorker extends EventEmitter implements EmbedWorkerProcess {
  readonly requests: EmbedWorkerRequest[] = [];
  readonly stdoutEmitter = new EventEmitter();
  readonly stderrEmitter = new EventEmitter();
  killed: string | null = null;
  exited = false;

  stdin = {
    write: (chunk: string) => {
      for (const line of chunk.split('\n').filter(Boolean)) {
        const req = JSON.parse(line) as EmbedWorkerRequest;
        this.requests.push(req);
        if (req.op === 'embed') {
          const reply = (this.behaviour.onEmbed ?? defaultEmbed)(req, this);
          if (reply) queueMicrotask(() => this.emitMessage(reply));
        } else if (req.op === 'shutdown') {
          queueMicrotask(() => this.exit(0, null));
        }
      }
      return true;
    },
    end: () => {},
    on: () => this.stdin,
  };
  stdout = { on: (_e: 'data', cb: (c: string) => void) => this.stdoutEmitter.on('data', cb) };
  stderr = { on: (_e: 'data', cb: (c: string) => void) => this.stderrEmitter.on('data', cb) };

  constructor(private readonly behaviour: Behaviour) {
    super();
    const hello = behaviour.hello === undefined ? ({ type: 'ready', model: MODEL, dim: DIM } as const) : behaviour.hello;
    if (hello) queueMicrotask(() => this.emitMessage(hello));
  }

  emitMessage(msg: EmbedWorkerMessage): void {
    // Split across chunks + library noise, like a real pipe.
    const line = encodeWorkerMessage(msg);
    this.stdoutEmitter.emit('data', 'onnxruntime warning: something\n');
    this.stdoutEmitter.emit('data', line.slice(0, 5));
    this.stdoutEmitter.emit('data', line.slice(5));
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = signal ?? 'SIGTERM';
    queueMicrotask(() => this.exit(null, (signal ?? 'SIGTERM') as NodeJS.Signals));
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, signal);
  }
}

const defaultEmbed: NonNullable<Behaviour['onEmbed']> = (req) => ({
  type: 'result',
  id: req.id,
  vectors: req.texts.map((_, i) => [i, 1, 0]),
});

function harness(behaviours: Behaviour[] | Behaviour, opts: ConstructorParameters<typeof EmbedWorkerClient>[0] = {}) {
  const list = Array.isArray(behaviours) ? behaviours : [behaviours];
  const workers: FakeWorker[] = [];
  const client = new EmbedWorkerClient({
    spawner: () => {
      const w = new FakeWorker(list[Math.min(workers.length, list.length - 1)]!);
      workers.push(w);
      return w;
    },
    ...opts,
  });
  return { client, workers };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('embed protocol', () => {
  it('ignores non-protocol and malformed lines', () => {
    expect(decodeWorkerLine('random log line')).toBeNull();
    expect(decodeWorkerLine('@@orcha-embed@@ {broken')).toBeNull();
    expect(decodeWorkerLine(encodeWorkerMessage({ type: 'idle' }).trim())).toEqual({ type: 'idle' });
  });
});

describe('EmbedWorkerClient', () => {
  it('spawns lazily, waits for ready, and round-trips an embed request', async () => {
    const { client, workers } = harness({});
    expect(workers.length).toBe(0);
    const vectors = await client.embed(['a', 'b'], 'query');
    expect(workers.length).toBe(1);
    expect(client.state).toBe('ready');
    expect(vectors.map((v) => Array.from(v))).toEqual([
      [0, 1, 0],
      [1, 1, 0],
    ]);
    expect(workers[0]!.requests[0]).toMatchObject({ op: 'embed', texts: ['a', 'b'], kind: 'query' });
    // A second request reuses the running worker.
    await client.embed(['c'], 'query');
    expect(workers.length).toBe(1);
  });

  it('is sticky-unavailable when the worker reports no embedder', async () => {
    const { client, workers } = harness({ hello: { type: 'unavailable', reason: 'disabled' } });
    await expect(client.embed(['a'], 'query')).rejects.toThrow('unavailable');
    await expect(client.embed(['a'], 'query')).rejects.toThrow('unavailable');
    expect(workers.length).toBe(1);
  });

  it('is unavailable without spawning when the spawner returns null', async () => {
    const client = new EmbedWorkerClient({ spawner: () => null });
    await expect(client.embed(['a'], 'query')).rejects.toThrow('unavailable');
    expect(client.state).toBe('unavailable');
  });

  it('rejects in-flight requests when the worker crashes, then restarts on demand', async () => {
    const { client, workers } = harness([
      { onEmbed: (_req, w) => (queueMicrotask(() => w.exit(null, 'SIGTRAP')), null) },
      {},
    ]);
    await expect(client.embed(['a'], 'query')).rejects.toThrow('exited');
    expect(client.state).toBe('stopped');
    const vectors = await client.embed(['a'], 'query');
    expect(vectors.length).toBe(1);
    expect(workers.length).toBe(2);
  });

  it('opens the circuit breaker after repeated crashes', async () => {
    const crash: Behaviour = { onEmbed: (_req, w) => (queueMicrotask(() => w.exit(null, 'SIGTRAP')), null) };
    const { client, workers } = harness(crash, { maxCrashes: 3 });
    for (let i = 0; i < 3; i++) await expect(client.embed(['a'], 'query')).rejects.toThrow();
    expect(client.state).toBe('broken');
    await expect(client.embed(['a'], 'query')).rejects.toThrow('broken');
    expect(workers.length).toBe(3); // no fourth spawn
  });

  it('forgets old crashes outside the window', async () => {
    let now = 0;
    const crash: Behaviour = { onEmbed: (_req, w) => (queueMicrotask(() => w.exit(null, 'SIGTRAP')), null) };
    const { client } = harness(crash, { maxCrashes: 2, crashWindowMs: 1_000, now: () => now });
    await expect(client.embed(['a'], 'query')).rejects.toThrow();
    now = 5_000;
    await expect(client.embed(['a'], 'query')).rejects.toThrow();
    expect(client.state).toBe('stopped');
  });

  it('times out a request the worker never answers', async () => {
    const { client } = harness({ onEmbed: () => null }, { requestTimeoutMs: 20 });
    await expect(client.embed(['a'], 'query')).rejects.toThrow('timed out');
  });

  it('kills a worker that never becomes ready', async () => {
    const { client, workers } = harness({ hello: null }, { startTimeoutMs: 20 });
    await expect(client.embed(['a'], 'query')).rejects.toThrow();
    expect(workers[0]!.killed).toBe('SIGKILL');
  });

  it('refuses a worker that loaded a different model', async () => {
    const { client } = harness({ hello: { type: 'ready', model: 'other-model', dim: 7 } });
    await expect(client.embed(['a'], 'query')).rejects.toThrow('unavailable');
  });

  it('sends index and sweep requests once ready', async () => {
    const { client, workers } = harness({});
    client.requestIndex(['/s/1', '/s/2']);
    client.requestSweep(['/ws']);
    await tick();
    expect(workers[0]!.requests).toEqual([
      { op: 'index', sessionDirs: ['/s/1', '/s/2'] },
      { op: 'sweep', workspaceRoots: ['/ws'] },
    ]);
  });

  it('shuts the worker down when idle, without counting it as a crash', async () => {
    const { client, workers } = harness({}, { idleShutdownMs: 20, maxCrashes: 1 });
    await client.embed(['a'], 'query');
    await new Promise((r) => setTimeout(r, 60));
    expect(workers[0]!.requests.some((r) => r.op === 'shutdown')).toBe(true);
    expect(client.state).toBe('stopped');
    await client.embed(['b'], 'query'); // restarts fine — breaker untouched
    expect(workers.length).toBe(2);
  });

  it('keeps the worker alive while indexing is in progress', async () => {
    const { client, workers } = harness({}, { idleShutdownMs: 20 });
    client.requestIndex(['/s/1']);
    await new Promise((r) => setTimeout(r, 60));
    expect(workers[0]!.requests.some((r) => r.op === 'shutdown')).toBe(false);
    workers[0]!.emitMessage({ type: 'idle' });
    await new Promise((r) => setTimeout(r, 60));
    expect(workers[0]!.requests.some((r) => r.op === 'shutdown')).toBe(true);
  });
});
