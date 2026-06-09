#!/usr/bin/env npx tsx
/**
 * Orcha Recall — cross-session ("resource-scoped") retrieval CLI.
 *
 * Thin wrapper around the pure recall engine
 * (packages/shared/src/sessions/recall-engine.ts). Lets us verify retrieval
 * against real workspace data by hand before wiring the same engine into the
 * agent as a `recall` tool (B2 pivot, step 2). The engine is the hard,
 * testable part; this CLI and the eventual agent-tool are both thin callers.
 *
 * CLI:
 *   orcha-recall <workspaceRoot> --text "<query>"            text search
 *   orcha-recall <workspaceRoot> --anchor feature:<id>       exact anchor
 *   orcha-recall <workspaceRoot> --text "x" --limit 5
 *   orcha-recall <workspaceRoot> --resolve <sessionId> <messageId>
 *
 * Output: JSON to stdout (one object: { hits } or { resolved }).
 *
 * Exit codes:
 *   0  ok
 *   1  bad args / missing workspace
 */

import { existsSync } from 'node:fs';
import { recall, resolvePointer, type RecallQuery } from '../packages/shared/src/sessions/recall-engine.ts';
import type { AnchorType } from '../packages/shared/src/sessions/anchors.ts';

function usage(): never {
  console.error('Usage:');
  console.error('  orcha-recall <workspaceRoot> --text "<query>" [--limit N] [--session <id>]');
  console.error('  orcha-recall <workspaceRoot> --anchor <type>:<id> [--limit N]');
  console.error('  orcha-recall <workspaceRoot> --resolve <sessionId> <messageId> [--before N] [--after N]');
  process.exit(1);
}

function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const workspaceRoot = process.argv[2];
if (!workspaceRoot || workspaceRoot.startsWith('--')) usage();
if (!existsSync(workspaceRoot)) {
  console.error(`Workspace root not found: ${workspaceRoot}`);
  process.exit(1);
}

// --- resolve mode -----------------------------------------------------------
if (process.argv.includes('--resolve')) {
  const i = process.argv.indexOf('--resolve');
  const sessionId = process.argv[i + 1];
  const messageId = process.argv[i + 2];
  if (!sessionId || !messageId) usage();
  const before = argVal('--before') ? Number(argVal('--before')) : undefined;
  const after = argVal('--after') ? Number(argVal('--after')) : undefined;
  const resolved = resolvePointer(workspaceRoot, sessionId, messageId, { before, after });
  process.stdout.write(JSON.stringify({ resolved }, null, 2) + '\n');
  process.exit(0);
}

// --- recall mode ------------------------------------------------------------
const query: RecallQuery = {};
const text = argVal('--text');
if (text) query.text = text;

const anchorRaw = argVal('--anchor');
if (anchorRaw) {
  const [type, ...rest] = anchorRaw.split(':');
  const id = rest.join(':');
  if (!type || !id) usage();
  query.anchor = { type: type as AnchorType, id };
}

const session = argVal('--session');
if (session) query.sessionId = session;

const limit = argVal('--limit');
if (limit) query.limit = Number(limit);

if (!query.text && !query.anchor && !query.sessionId) {
  // Allow empty → most-recent, but warn so it isn't a silent surprise.
  console.error('[orcha-recall] no --text/--anchor/--session given → returning most-recent observations');
}

const hits = recall(workspaceRoot, query);
process.stdout.write(JSON.stringify({ count: hits.length, hits }, null, 2) + '\n');
process.exit(0);
