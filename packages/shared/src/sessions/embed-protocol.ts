/**
 * Wire protocol between the app (`embed-client.ts`) and the embed worker
 * (`scripts/orcha-embed-worker.ts`): newline-delimited JSON.
 *
 * stdin/stdout rather than a Node IPC channel because the dev runtime spawns
 * `npx tsx <script>` — the wrapper processes don't forward an IPC fd, but
 * stdio pipes pass through unchanged. Worker → app lines carry a fixed prefix
 * so stray library output on stdout can never be mistaken for a message (the
 * worker also redirects console.* to stderr).
 */

import type { EmbedKind } from './embedder.ts';

export const EMBED_PROTOCOL_PREFIX = '@@orcha-embed@@ ';

/** App → worker. */
export type EmbedWorkerRequest =
  | { op: 'embed'; id: number; texts: string[]; kind: EmbedKind }
  | { op: 'index'; sessionDirs: string[] }
  /** Scan these workspaces for sessions with an embedding backlog, then index them. */
  | { op: 'sweep'; workspaceRoots: string[] }
  | { op: 'shutdown' };

/** Worker → app. */
export type EmbedWorkerMessage =
  | { type: 'ready'; model: string; dim: number }
  | { type: 'unavailable'; reason: string }
  | { type: 'result'; id: number; vectors: number[][] }
  | { type: 'error'; id: number; message: string }
  | { type: 'indexed'; sessionDir: string; embedded: number }
  | { type: 'index-error'; sessionDir: string; message: string }
  | { type: 'idle' };

export function encodeWorkerMessage(msg: EmbedWorkerMessage): string {
  return `${EMBED_PROTOCOL_PREFIX}${JSON.stringify(msg)}\n`;
}

/** Parse one stdout line; null for non-protocol noise or malformed JSON. */
export function decodeWorkerLine(line: string): EmbedWorkerMessage | null {
  if (!line.startsWith(EMBED_PROTOCOL_PREFIX)) return null;
  try {
    const msg = JSON.parse(line.slice(EMBED_PROTOCOL_PREFIX.length)) as EmbedWorkerMessage;
    return msg && typeof msg === 'object' && typeof msg.type === 'string' ? msg : null;
  } catch {
    return null;
  }
}
