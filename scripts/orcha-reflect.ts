#!/usr/bin/env npx tsx
/**
 * Orcha Reflector — L2 condensation of L1 observations.
 *
 * Mastra observational-memory reference: when observations exceed ~40k
 * tokens, a Reflector agent restructures and condenses them — combining
 * related items, reflecting on overarching patterns, and dropping context
 * that is no longer relevant.
 *
 * This script implements that for orcha-agents:
 *   1. Read <session>/data/observations.json
 *   2. Estimate token count (chars/4 heuristic, like Mastra)
 *   3. If above threshold (default 40_000), call LLM with reflector prompt
 *   4. Replace condensed observations in-place; keep recent raw ones
 *      untouched as a tail buffer
 *   5. Optionally bridge high-salience condensed items as RawSignals into
 *      the Orcha-CLI ledger via `orcha signal add-many --from-json`
 *
 * CLI:
 *   npx tsx scripts/orcha-reflect.ts [<sessionDir>]
 *   ORCHA_REFLECT_FORCE=1 npx tsx scripts/orcha-reflect.ts   # ignore threshold
 *
 * Resolution order for the session being reflected:
 *   1. CLI arg
 *   2. CRAFT_SESSION_ID env
 *   3. Auto-detect most recent session under sessions/
 *
 * Resolution order for the LLM extractor: same as orcha-observe.ts.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  copyFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TOKEN_THRESHOLD = 40_000;
const TAIL_RAW_KEEP = 10; // never reflect the most recent N raw observations

// ============================================================================
// Types (mirror observation-watermark.ObservationSignal layout)
// ============================================================================

interface ObservationSignal {
  id: string;
  createdAt: string;
  source: string;
  summary: string;
  status: string;
  salience?: 'pivotal' | 'question' | 'context' | string;
  anchorRefs?: unknown[];
  conversation?: {
    sessionId?: string;
    messageRange?: { from?: string; to?: string };
    excerpt?: string;
    actor?: 'user' | 'assistant' | 'agent' | string;
  };
  /** Marker set by reflector when this entry is a condensed L2 observation. */
  compressed?: boolean;
  /** IDs of L1 observations that were collapsed into this L2 entry. */
  replacedIds?: string[];
}

interface ReflectionWatermark {
  sessionId: string;
  lastReflectedAt: string;
  totalRunsCount: number;
  lastInputCount: number;
  lastOutputCount: number;
  lastTokenEstimate: number;
}

// ============================================================================
// Session detection (same logic as orcha-observe.ts)
// ============================================================================

function findMostRecentSession(): string | null {
  const sessionsDir = join(process.cwd(), 'sessions');
  if (!existsSync(sessionsDir)) return null;
  let best: { dir: string; mtime: number } | null = null;
  for (const name of readdirSync(sessionsDir)) {
    const dir = join(sessionsDir, name);
    const jsonl = join(dir, 'session.jsonl');
    if (!existsSync(jsonl)) continue;
    const m = statSync(jsonl).mtimeMs;
    if (!best || m > best.mtime) best = { dir, mtime: m };
  }
  return best?.dir ?? null;
}

function resolveSessionDir(argv: string[]): string | null {
  if (argv[2]) return argv[2];
  if (process.env.CRAFT_SESSION_ID) {
    return join(process.cwd(), 'sessions', process.env.CRAFT_SESSION_ID);
  }
  return findMostRecentSession();
}

// ============================================================================
// Reflector prompt (Mastra-style: restructure + condense + drop irrelevant)
// ============================================================================

function buildReflectorSystemPrompt(): string {
  return `You are a Reflector for an Observational Memory system. Your job: read a list of structured observations and produce a CONDENSED, RESTRUCTURED version.

Discipline (MUST follow):
1. Group related observations into a single denser observation.
2. State changes OVERRIDE prior states. If observation B supersedes A (e.g., user switched from option X to Y), drop A and keep B — or merge them as "user moved from X to Y".
3. Drop pure noise: chitchat, completed transient steps, redundant restatements.
4. Preserve all "pivotal" observations unless explicitly superseded — they encode decisions and constraints.
5. Preserve open "question" observations until they are resolved (an answering "pivotal" lets you drop the question).
6. NEVER invent facts. Only condense what is in the input.
7. Keep summaries SHORT (≤ 140 chars) and in third-person fact form, like the originals.
8. Each output observation MUST list the IDs of input observations it replaces in "replacedIds".

Salience taxonomy (same as input):
  - "pivotal" 🔴: decisions, constraints, corrections, schema/architecture choices
  - "question" 🟡: open questions awaiting answers
  - "context" 🟢: ambient state, completed steps, references

Output schema — return ONLY this JSON, nothing else:

{
  "condensed": [
    {
      "summary": string,                       // ≤ 140 chars
      "salience": "pivotal" | "question" | "context",
      "actor": "user" | "agent",
      "anchorRefs": string[],                  // anchor IDs if any (titles or UUIDs ok)
      "replacedIds": string[],                 // input observation IDs being collapsed
      "excerpt": string                        // ~120 chars; can be a synthesized summary excerpt
    }
  ],
  "drop": string[]                              // input IDs to drop entirely (noise/superseded)
}

Any input ID NOT mentioned in either "replacedIds" or "drop" is implicitly KEPT as-is.

Examples of good restructuring:
  Inputs:
    [obs-1] (context) "user inspecting layout bug in swimlane"
    [obs-2] (context) "tried fix A — didn't work"
    [obs-3] (pivotal) "user decided fix B is correct approach"
    [obs-4] (context) "fix B applied"
  Output:
    condensed: [{ summary: "Fix B chosen for swimlane layout bug after fix A failed; applied", salience: "pivotal", replacedIds: [obs-1, obs-2, obs-3, obs-4], ... }]

Return ONLY valid JSON.`;
}

function buildReflectorUserPrompt(items: ObservationSignal[]): string {
  const lines = items.map((s) => {
    const anchors =
      Array.isArray(s.anchorRefs) && s.anchorRefs.length > 0
        ? ` anchors=[${s.anchorRefs
            .map((a) => {
              if (typeof a === 'string') return a;
              const obj = a as Record<string, unknown>;
              return (obj.title as string) ?? (obj.id as string) ?? '';
            })
            .filter(Boolean)
            .join(',')}]`
        : '';
    const sal = s.salience ?? 'context';
    const summary = s.summary.replace(/\s+/g, ' ').trim().slice(0, 280);
    return `[${s.id}] (${sal})${anchors} ${summary}`;
  });
  return `Observations to condense (${items.length} items):\n\n${lines.join(
    '\n',
  )}\n\nReturn JSON.`;
}

// ============================================================================
// LLM extractor — same auth strategy as orcha-observe.ts
// ============================================================================

type ExtractorMode =
  | { kind: 'cli'; cliPath: string; model: string }
  | { kind: 'api'; apiKey: string; model: string; endpoint: string; apiVersion: string };

function findClaudeBinary(): string | null {
  const candidates: string[] = [];
  const appRoot = process.env.CRAFT_APP_ROOT;
  if (appRoot) {
    candidates.push(
      join(appRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-darwin-arm64', 'claude'),
      join(appRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-binary', 'claude'),
      join(appRoot, 'apps', 'electron', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-binary', 'claude'),
    );
  }
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    candidates.push(
      join(resourcesPath, 'app', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-binary', 'claude'),
    );
  }
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function resolveExtractor(): ExtractorMode | null {
  const model = process.env.ORCHA_REFLECTOR_MODEL ?? process.env.ORCHA_OBSERVER_MODEL ?? 'claude-sonnet-4-6';
  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauth) {
    const cliPath = process.env.ORCHA_OBSERVER_CLI_PATH ?? findClaudeBinary();
    if (cliPath) return { kind: 'cli', cliPath, model };
  }
  const apiKey =
    process.env.ORCHA_REFLECTOR_API_KEY ??
    process.env.ORCHA_OBSERVER_API_KEY ??
    process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    return {
      kind: 'api',
      apiKey,
      model,
      endpoint: 'https://api.anthropic.com/v1/messages',
      apiVersion: '2023-06-01',
    };
  }
  return null;
}

interface AnthropicMessagesResponse {
  content?: Array<{ type: string; text?: string }>;
  error?: { message?: string };
}

async function callClaudeCLI(
  cliPath: string,
  model: string,
  system: string,
  user: string,
): Promise<string | null> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(
      cliPath,
      [
        '--print',
        '--model', model,
        '--append-system-prompt', system,
        '--disable-slash-commands',
        '--exclude-dynamic-system-prompt-sections',
        user,
      ],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      console.warn('Reflector: claude CLI timed out after 90s');
      resolve(null);
    }, 90_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim() || null);
      else {
        console.warn(`Reflector: claude CLI exited ${code}: ${stderr.trim().slice(0, 300) || stdout.trim().slice(0, 300)}`);
        resolve(null);
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      console.warn(`Reflector: claude CLI spawn error: ${err.message}`);
      resolve(null);
    });
  });
}

async function callAnthropicAPI(
  apiKey: string,
  model: string,
  endpoint: string,
  apiVersion: string,
  system: string,
  user: string,
): Promise<string | null> {
  const body = {
    model,
    max_tokens: 8192,
    temperature: 0.4,
    system,
    messages: [{ role: 'user', content: user }],
  };
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': apiVersion,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(`Reflector: Anthropic call failed (${res.status}): ${text.slice(0, 200)}`);
    return null;
  }
  const json = (await res.json()) as AnthropicMessagesResponse;
  if (json.error) {
    console.warn(`Reflector: Anthropic error: ${json.error.message ?? 'unknown'}`);
    return null;
  }
  return (json.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .trim();
}

async function callExtractor(mode: ExtractorMode, system: string, user: string): Promise<string | null> {
  if (mode.kind === 'cli') return callClaudeCLI(mode.cliPath, mode.model, system, user);
  return callAnthropicAPI(mode.apiKey, mode.model, mode.endpoint, mode.apiVersion, system, user);
}

// ============================================================================
// Reflector output parsing
// ============================================================================

interface ReflectorOutput {
  condensed: Array<{
    summary: string;
    salience: 'pivotal' | 'question' | 'context';
    actor: 'user' | 'agent';
    anchorRefs?: string[];
    replacedIds: string[];
    excerpt?: string;
  }>;
  drop: string[];
}

function parseReflectorJson(raw: string): ReflectorOutput | null {
  let text = raw.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
  }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const condensedArr = Array.isArray(parsed.condensed) ? parsed.condensed : [];
    const dropArr = Array.isArray(parsed.drop) ? parsed.drop.filter((x) => typeof x === 'string') as string[] : [];
    const condensed: ReflectorOutput['condensed'] = [];
    for (const entry of condensedArr) {
      if (!entry || typeof entry !== 'object') continue;
      const o = entry as Record<string, unknown>;
      const summary = typeof o.summary === 'string' ? o.summary : null;
      const salience =
        o.salience === 'pivotal' || o.salience === 'question' || o.salience === 'context'
          ? o.salience
          : null;
      const actor = o.actor === 'user' || o.actor === 'agent' ? o.actor : 'agent';
      const replacedIds = Array.isArray(o.replacedIds)
        ? (o.replacedIds.filter((x) => typeof x === 'string') as string[])
        : [];
      const anchorRefs = Array.isArray(o.anchorRefs)
        ? (o.anchorRefs.filter((x) => typeof x === 'string') as string[])
        : undefined;
      const excerpt = typeof o.excerpt === 'string' ? o.excerpt : '';
      if (!summary || !salience || replacedIds.length === 0) continue;
      condensed.push({ summary, salience, actor, anchorRefs, replacedIds, excerpt });
    }
    return { condensed, drop: dropArr };
  } catch (err) {
    console.warn(`Reflector: failed to parse JSON output: ${(err as Error).message}`);
    return null;
  }
}

// ============================================================================
// Token estimation (Mastra uses chars/4 as approximation)
// ============================================================================

function estimateTokens(items: ObservationSignal[]): number {
  let total = 0;
  for (const s of items) {
    total += (s.summary?.length ?? 0) + (s.conversation?.excerpt?.length ?? 0);
  }
  return Math.ceil(total / 4);
}

// ============================================================================
// Bridge to Orcha-CLI ledger (optional)
// ============================================================================

function findOrchaProjectDir(): string | null {
  const explicit = process.env.ORCHA_LEDGER_PROJECT_DIR;
  if (explicit) {
    const expanded = explicit.replace(/^~/, process.env.HOME || '~');
    return existsSync(expanded) ? expanded : null;
  }
  const home = process.env.HOME;
  if (!home) return null;
  const guess = join(home, 'Developer', 'orcha');
  if (existsSync(join(guess, '.orcha-ledger.json')) || existsSync(join(guess, 'packages', 'cli'))) {
    return guess;
  }
  return null;
}

function bridgeToOrchaLedger(
  sessionDir: string,
  sessionId: string,
  condensed: ObservationSignal[],
): { bridged: number; reason: string } {
  if (process.env.ORCHA_REFLECTOR_DISABLE_BRIDGE === '1') {
    return { bridged: 0, reason: 'bridge disabled (ORCHA_REFLECTOR_DISABLE_BRIDGE=1)' };
  }
  const orchaDir = findOrchaProjectDir();
  if (!orchaDir) {
    return { bridged: 0, reason: 'no orcha project dir found (set ORCHA_LEDGER_PROJECT_DIR)' };
  }

  // Bridge only pivotal + question (skip pure context — Mastra-aligned signal/noise)
  const bridgeable = condensed.filter(
    (c) => c.salience === 'pivotal' || c.salience === 'question',
  );
  if (bridgeable.length === 0) {
    return { bridged: 0, reason: 'no pivotal/question items to bridge' };
  }

  const dataDir = join(sessionDir, 'data');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const batchPath = join(dataDir, 'orcha-bridge-batch.json');

  const payload = {
    signals: bridgeable.map((c) => ({
      summary: c.summary,
      source: 'conversation',
      salience: c.salience,
      anchorRefs: anchorIdsOnly(c.anchorRefs),
      conversation: {
        sessionId,
        excerpt: c.conversation?.excerpt ?? '',
        actor: normalizeActor(c.conversation?.actor),
        messageRange: c.conversation?.messageRange,
      },
    })),
  };
  writeFileSync(batchPath, JSON.stringify(payload, null, 2), 'utf-8');

  const cliEntry = join(orchaDir, 'packages', 'cli', 'src', 'index.ts');
  if (!existsSync(cliEntry)) {
    return { bridged: 0, reason: `orcha CLI not at ${cliEntry}` };
  }

  const result = spawnSync(
    'pnpm',
    ['dlx', 'tsx', cliEntry, 'signal', 'add-many', '--from-json', batchPath],
    { cwd: orchaDir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
  );

  if (result.status === 0 || result.status === 2) {
    // 0 = all good, 2 = partial (some bad entries) — both "wrote some"
    return {
      bridged: bridgeable.length,
      reason: `orcha signal add-many → ${(result.stderr || result.stdout || '').trim().split('\n').slice(0, 2).join(' | ')}`,
    };
  }
  return {
    bridged: 0,
    reason: `bridge subprocess failed (exit ${result.status}): ${(result.stderr || '').slice(0, 200)}`,
  };
}

function anchorIdsOnly(anchors: unknown): string[] | undefined {
  if (!Array.isArray(anchors)) return undefined;
  const ids: string[] = [];
  for (const a of anchors) {
    if (typeof a === 'string') ids.push(a);
    else if (a && typeof a === 'object') {
      const obj = a as Record<string, unknown>;
      if (typeof obj.id === 'string') ids.push(obj.id);
    }
  }
  return ids.length > 0 ? ids : undefined;
}

function normalizeActor(a: unknown): 'user' | 'assistant' | undefined {
  if (a === 'user') return 'user';
  if (a === 'assistant' || a === 'agent') return 'assistant';
  return undefined;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const sessionDir = resolveSessionDir(process.argv);
  if (!sessionDir) {
    console.log('Reflector: no session dir resolved, skipping.');
    return;
  }
  const expandedDir = sessionDir.replace(/^~/, process.env.HOME || '~');
  const obsPath = join(expandedDir, 'data', 'observations.json');
  if (!existsSync(obsPath)) {
    console.log(`Reflector: no observations.json at ${obsPath}, skipping.`);
    return;
  }

  // Load existing observations
  let raw: { signals?: ObservationSignal[] } | ObservationSignal[];
  try {
    raw = JSON.parse(readFileSync(obsPath, 'utf-8'));
  } catch (err) {
    console.error(`Reflector: failed to parse ${obsPath}: ${(err as Error).message}`);
    process.exit(1);
  }
  const all: ObservationSignal[] = Array.isArray(raw) ? raw : raw.signals ?? [];
  if (all.length === 0) {
    console.log('Reflector: observations.json is empty, skipping.');
    return;
  }

  // Threshold check (Mastra: ~40k token threshold, char/4 estimate)
  const threshold = Number(process.env.ORCHA_REFLECTOR_THRESHOLD_TOKENS ?? DEFAULT_TOKEN_THRESHOLD);
  const force = process.env.ORCHA_REFLECT_FORCE === '1';
  const tokenEstimate = estimateTokens(all);
  if (!force && tokenEstimate < threshold) {
    console.log(
      `Reflector: ${all.length} obs ≈ ${tokenEstimate} tokens, below threshold ${threshold}; skipping.`,
    );
    return;
  }

  // Split: tail buffer (most recent N raw) is preserved untouched.
  const reflectable = all.slice(0, Math.max(0, all.length - TAIL_RAW_KEEP));
  const tail = all.slice(Math.max(0, all.length - TAIL_RAW_KEEP));
  // Don't reflect already-compressed entries again (idempotency).
  const candidates = reflectable.filter((s) => !s.compressed);
  const alreadyCompressed = reflectable.filter((s) => s.compressed);
  if (candidates.length === 0) {
    console.log('Reflector: nothing to reflect (all reflectable items already compressed).');
    return;
  }

  // Resolve LLM
  const extractor = resolveExtractor();
  if (!extractor) {
    console.warn('Reflector: no LLM auth available (no OAuth token, no API key). Aborting.');
    process.exit(1);
  }

  const system = buildReflectorSystemPrompt();
  const user = buildReflectorUserPrompt(candidates);
  const responseText = await callExtractor(extractor, system, user);
  if (!responseText) {
    console.warn('Reflector: LLM returned no text.');
    process.exit(1);
  }
  const parsed = parseReflectorJson(responseText);
  if (!parsed) {
    console.warn('Reflector: failed to parse LLM JSON; aborting without write.');
    process.exit(1);
  }

  // Backup before mutation
  const backupPath = obsPath.replace(/\.json$/, `.before-reflect-${Date.now()}.json`);
  copyFileSync(obsPath, backupPath);

  // Build new observation list:
  //   - Drop IDs in parsed.drop
  //   - Replace items whose IDs appear in any condensed.replacedIds
  //   - Append condensed entries
  //   - Keep alreadyCompressed unchanged
  //   - Keep tail unchanged
  const dropSet = new Set(parsed.drop);
  const replacedSet = new Set<string>();
  for (const c of parsed.condensed) for (const id of c.replacedIds) replacedSet.add(id);

  const sessionIdForOutput = candidates[0]?.conversation?.sessionId ?? expandedDir.split('/').pop() ?? 'unknown';

  const condensedSignals: ObservationSignal[] = parsed.condensed.map((c, idx) => {
    // Inherit anchorRefs from the first replaced original if reflector didn't provide
    const inherited =
      c.anchorRefs && c.anchorRefs.length > 0
        ? c.anchorRefs
        : firstAnchorRefs(candidates, c.replacedIds);
    return {
      id: `obs-l2-${Date.now()}-${idx}`,
      createdAt: new Date().toISOString(),
      source: 'conversation',
      summary: c.summary,
      status: 'raw',
      salience: c.salience,
      anchorRefs: inherited,
      conversation: {
        sessionId: sessionIdForOutput,
        excerpt: c.excerpt ?? '',
        actor: c.actor === 'user' ? 'user' : 'agent',
      },
      compressed: true,
      replacedIds: c.replacedIds,
    };
  });

  const survivingFromCandidates = candidates.filter(
    (s) => !dropSet.has(s.id) && !replacedSet.has(s.id),
  );

  const newAll: ObservationSignal[] = [
    ...alreadyCompressed,
    ...survivingFromCandidates,
    ...condensedSignals,
    ...tail,
  ];

  // Write new observations.json (atomic-ish via write+rename would be nicer, defer)
  writeFileSync(obsPath, JSON.stringify({ signals: newAll }, null, 2) + '\n', 'utf-8');

  // Touch watermark so UI re-fetches
  const watermarkPath = join(expandedDir, 'meta', 'observation-watermark.json');
  if (existsSync(watermarkPath)) {
    try {
      const w = JSON.parse(readFileSync(watermarkPath, 'utf-8'));
      w.lastObservedAt = new Date().toISOString();
      writeFileSync(watermarkPath, JSON.stringify(w, null, 2), 'utf-8');
    } catch {
      /* non-fatal */
    }
  }

  // Write reflection-watermark
  const reflectMetaDir = join(expandedDir, 'meta');
  if (!existsSync(reflectMetaDir)) mkdirSync(reflectMetaDir, { recursive: true });
  const reflectWatermarkPath = join(reflectMetaDir, 'reflection-watermark.json');
  let prevRuns = 0;
  if (existsSync(reflectWatermarkPath)) {
    try {
      prevRuns = (JSON.parse(readFileSync(reflectWatermarkPath, 'utf-8')) as ReflectionWatermark)
        .totalRunsCount ?? 0;
    } catch {
      /* ignore */
    }
  }
  const newWatermark: ReflectionWatermark = {
    sessionId: sessionIdForOutput,
    lastReflectedAt: new Date().toISOString(),
    totalRunsCount: prevRuns + 1,
    lastInputCount: candidates.length,
    lastOutputCount: condensedSignals.length,
    lastTokenEstimate: tokenEstimate,
  };
  writeFileSync(reflectWatermarkPath, JSON.stringify(newWatermark, null, 2), 'utf-8');

  // Bridge condensed pivotal/question items to Orcha-CLI ledger
  const bridge = bridgeToOrchaLedger(expandedDir, sessionIdForOutput, condensedSignals);

  console.log(
    `Reflector: condensed ${candidates.length} → ${condensedSignals.length} (${parsed.drop.length} dropped, ${survivingFromCandidates.length} kept).\n` +
      `  Token estimate: ${tokenEstimate}\n` +
      `  Tail buffer (untouched): ${tail.length}\n` +
      `  Bridge: ${bridge.bridged} → ${bridge.reason}\n` +
      `  Backup: ${backupPath}\n` +
      `  Output: ${obsPath}`,
  );
}

function firstAnchorRefs(items: ObservationSignal[], ids: string[]): unknown[] | undefined {
  for (const id of ids) {
    const m = items.find((s) => s.id === id);
    if (m && Array.isArray(m.anchorRefs) && m.anchorRefs.length > 0) return m.anchorRefs;
  }
  return undefined;
}

main().catch((err) => {
  console.error('Reflector error:', err);
  process.exit(1);
});
