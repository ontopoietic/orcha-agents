#!/usr/bin/env npx tsx
/**
 * Orcha Embed Worker — the only long-lived owner of the ONNX embedding model.
 *
 * Spawned and supervised by `packages/shared/src/sessions/embed-client.ts`.
 * Runs in its own process so a native ONNX failure (e.g. an allocation abort,
 * which killed the Electron main process on 2026-09-30) only takes down this
 * worker; the app falls back to text recall and restarts it on demand.
 *
 * Protocol: see `embed-protocol.ts` (NDJSON over stdin/stdout).
 *   embed    — query embeddings, answered immediately (they interleave with
 *              indexing between 16-text batches)
 *   index    — queue session dirs; the worker brings their vector sidecars
 *              up to date one session at a time, persisting per chunk
 *   sweep    — scan whole workspaces for sessions with a backlog, then index
 *   shutdown — exit
 * The worker also exits when stdin closes, so it never outlives the app.
 */

import { createInterface } from 'node:readline';
import { resolveEmbedder } from '../packages/shared/src/sessions/embedder.ts';
import {
  findSessionsNeedingEmbeddings,
  indexSessionEmbeddings,
} from '../packages/shared/src/sessions/embed-index.ts';
import {
  encodeWorkerMessage,
  type EmbedWorkerMessage,
  type EmbedWorkerRequest,
} from '../packages/shared/src/sessions/embed-protocol.ts';

// stdout is the protocol channel — route every library log to stderr.
for (const level of ['log', 'info', 'debug', 'warn'] as const) {
  console[level] = (...args: unknown[]) => console.error(...args);
}

function send(msg: EmbedWorkerMessage): void {
  process.stdout.write(encodeWorkerMessage(msg));
}

async function main(): Promise<void> {
  const embedder = await resolveEmbedder();
  if (!embedder) {
    send({ type: 'unavailable', reason: 'embedder unavailable (disabled, package missing, or model failed to load)' });
    process.exit(0);
  }
  send({ type: 'ready', model: embedder.model, dim: embedder.dim });

  // Once onnxruntime-node is loaded, a normal exit() aborts on macOS: its
  // global destructors throw "mutex lock failed" (SIGABRT + a crash report per
  // exit). So: release the sessions, flush stdout, then terminate by signal —
  // SIGTERM's default action skips the C++ static destructors entirely. The
  // client treats this as an intentional stop (it initiated it or is gone).
  let exiting = false;
  async function shutdown(): Promise<void> {
    if (exiting) return;
    exiting = true;
    try {
      await embedder!.dispose?.();
    } catch {
      // exiting anyway
    }
    process.stdout.write('', () => process.kill(process.pid, 'SIGTERM'));
  }

  const queue: string[] = [];
  const queued = new Set<string>();
  let draining = false;

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    while (queue.length > 0) {
      const sessionDir = queue.shift()!;
      queued.delete(sessionDir);
      try {
        const embedded = await indexSessionEmbeddings(sessionDir, embedder!);
        send({ type: 'indexed', sessionDir, embedded });
      } catch (error) {
        send({ type: 'index-error', sessionDir, message: error instanceof Error ? error.message : String(error) });
      }
      await new Promise<void>((r) => setImmediate(r));
    }
    draining = false;
    send({ type: 'idle' });
  }

  function enqueue(sessionDirs: string[]): void {
    for (const dir of sessionDirs) {
      if (!queued.has(dir)) {
        queued.add(dir);
        queue.push(dir);
      }
    }
    void drain();
  }

  const rl = createInterface({ input: process.stdin });
  rl.on('close', () => void shutdown());
  rl.on('line', (line) => {
    let req: EmbedWorkerRequest;
    try {
      req = JSON.parse(line) as EmbedWorkerRequest;
    } catch {
      return;
    }
    if (req.op === 'embed') {
      embedder!
        .embed(req.texts, req.kind)
        .then((vectors) => send({ type: 'result', id: req.id, vectors: vectors.map((v) => Array.from(v)) }))
        .catch((error) =>
          send({ type: 'error', id: req.id, message: error instanceof Error ? error.message : String(error) }),
        );
    } else if (req.op === 'index') {
      enqueue(req.sessionDirs);
    } else if (req.op === 'sweep') {
      // The scan reads every session's ledger — done here so the app's
      // event loop never pays for it.
      enqueue(findSessionsNeedingEmbeddings(req.workspaceRoots, embedder!));
    } else if (req.op === 'shutdown') {
      void shutdown();
    }
  });
}

main().catch((error) => {
  console.error('Embed worker failed:', error);
  process.exit(1);
});
