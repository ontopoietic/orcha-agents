#!/usr/bin/env npx tsx
/**
 * Orcha Observer — Echo Rewrite
 *
 * One-shot maintenance tool: scan an existing observations.json, find
 * entries whose summary mirrors the excerpt (echoes — the LLM extractor
 * copy-pasted instead of summarizing), re-extract them via the current
 * extractor configuration, and write the file back in place.
 *
 * Only safe to run when session.jsonl still contains the source messages
 * the echoes refer to — i.e. before SDK compaction has discarded them.
 *
 * Usage:
 *   npx tsx scripts/orcha-observe-rewrite-echoes.ts <sessionDir>
 *
 * Reuses the LLM-extractor wiring from orcha-observe.ts via dynamic import
 * so we keep a single source of truth for the prompt + provider config.
 *
 * Exit codes:
 *   0 — finished (may have rewritten 0 entries; check stdout)
 *   1 — fatal error
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM-safe equivalent of __dirname
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

interface ObservationSignal {
  id: string;
  createdAt: string;
  source: string;
  summary: string;
  status: string;
  salience?: string;
  anchorRefs?: unknown[];
  conversation?: {
    sessionId?: string;
    messageRange?: { from?: string; to?: string };
    excerpt?: string;
    actor?: 'user' | 'agent' | 'mixed' | string;
  };
}

interface JsonlMessage {
  id: string;
  type?: string;
  content?: string;
  timestamp?: number;
}

// ============================================================================
// Echo detection (must match orcha-observe.ts exactly)
// ============================================================================

function isEcho(summary: string, excerpt: string): boolean {
  if (!summary || !excerpt) return false;
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const s = norm(summary).replace(/^[^a-z0-9]*(user stated|user asked|observed):\s*/, '');
  const e = norm(excerpt);
  if (s.length < 30) return false;
  const head = s.slice(0, 50);
  return e.startsWith(head) || s.startsWith(e.slice(0, 50));
}

// ============================================================================
// LLM extractor (parallel to orcha-observe.ts buildObserverSystemPrompt)
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
    );
  }
  // Heuristic fallback for when CRAFT_APP_ROOT is missing — script lives in
  // orcha-agents/scripts so its parent's node_modules holds the binary.
  candidates.push(
    join(SCRIPT_DIR, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-darwin-arm64', 'claude'),
  );
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function resolveExtractor(): ExtractorMode | null {
  const model = process.env.ORCHA_OBSERVER_MODEL ?? 'claude-sonnet-4-6';

  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    const cliPath = process.env.ORCHA_OBSERVER_CLI_PATH ?? findClaudeBinary();
    if (cliPath) return { kind: 'cli', cliPath, model };
  }

  const apiKey = process.env.ORCHA_OBSERVER_API_KEY ?? process.env.ANTHROPIC_API_KEY;
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

function buildSystemPrompt(): string {
  // Same rules as orcha-observe.ts but tailored for single-message rewrite
  return `You are rewriting a flawed Observational Memory entry. The previous extractor copy-pasted the source message as the "summary" instead of extracting a fact. Your job: produce a proper extracted fact.

ABSOLUTE RULE — DO NOT ECHO:
The summary is NOT the message. It is a *fact extracted from* the message,
written from the outside, in the third person. NEVER copy a sentence
verbatim. NEVER paraphrase by reordering. NEVER include "the user said X"
boilerplate — write the resulting state.

Hard target: summary ≤ 140 characters. Reformulated, not quoted.

Salience taxonomy (preserve the existing label unless it's clearly wrong):
- "pivotal" 🔴: user assertions, decisions, constraints, corrections
- "question" 🟡: open questions awaiting answers
- "context" 🟢: ambient state, completed steps, references

Examples:
  BAD: "Should we use Cloudflare D1 or Turso?"
  GOOD: "Open question: D1 vs. Turso for the database"

  BAD: "Der Fix hat funktioniert. Nun folgendes: Manche Kanten…"
  GOOD: "Backward edges still route through other nodes; user wants outside routing"

If the source message is too thin to extract a meaningful fact, return
{"skip": true} and the entry will be dropped.

Output JSON: { "summary": string, "salience": "pivotal"|"question"|"context" }
or { "skip": true }. No prose around it.`;
}

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  error?: { message?: string };
}

async function callClaudeCLI(cliPath: string, model: string, system: string, user: string): Promise<string | null> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(cliPath, [
      '--print',
      '--model', model,
      '--append-system-prompt', system,
      '--disable-slash-commands',
      '--exclude-dynamic-system-prompt-sections',
      user,
    ], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve(null);
    }, 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim() || null);
      else {
        console.warn(`claude CLI exit ${code}: ${stderr.slice(0, 200) || stdout.slice(0, 200)}`);
        resolve(null);
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      console.warn(`claude CLI spawn error: ${err.message}`);
      resolve(null);
    });
  });
}

async function callAnthropicAPI(apiKey: string, model: string, endpoint: string, apiVersion: string, system: string, user: string): Promise<string | null> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': apiVersion,
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      temperature: 0.6,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(`Anthropic ${res.status}: ${text.slice(0, 200)}`);
    return null;
  }
  const json = (await res.json()) as AnthropicResponse;
  if (json.error) {
    console.warn(`Anthropic error: ${json.error.message ?? 'unknown'}`);
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

interface RewriteResult {
  summary?: string;
  salience?: 'pivotal' | 'question' | 'context';
  skip?: boolean;
}

function parseRewriteResponse(raw: string): RewriteResult | null {
  let text = raw.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
  }
  try {
    const parsed = JSON.parse(text) as RewriteResult;
    if (parsed.skip === true) return { skip: true };
    if (typeof parsed.summary !== 'string') return null;
    if (parsed.salience && !['pivotal', 'question', 'context'].includes(parsed.salience)) {
      delete parsed.salience;
    }
    return parsed;
  } catch {
    return null;
  }
}

// ============================================================================
// JSONL message lookup
// ============================================================================

function buildMessageIndex(jsonlPath: string): Map<string, JsonlMessage> {
  const map = new Map<string, JsonlMessage>();
  if (!existsSync(jsonlPath)) return map;
  const raw = readFileSync(jsonlPath, 'utf-8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as JsonlMessage;
      if (parsed.id) map.set(parsed.id, parsed);
    } catch {
      // Skip malformed lines.
    }
  }
  return map;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const sessionDir = process.argv[2];
  if (!sessionDir) {
    console.error('Usage: orcha-observe-rewrite-echoes.ts <sessionDir>');
    process.exit(1);
  }
  const obsPath = join(sessionDir, 'data', 'observations.json');
  const jsonlPath = join(sessionDir, 'session.jsonl');
  if (!existsSync(obsPath)) {
    console.error(`No observations.json at ${obsPath}`);
    process.exit(1);
  }
  if (!existsSync(jsonlPath)) {
    console.error(`No session.jsonl at ${jsonlPath} — cannot rewrite without source messages`);
    process.exit(1);
  }

  const extractor = resolveExtractor();
  if (!extractor) {
    console.error('No LLM auth: set CLAUDE_CODE_OAUTH_TOKEN (Pro/Team) or ANTHROPIC_API_KEY. The Electron app passes CLAUDE_CODE_OAUTH_TOKEN to subprocesses automatically — run from inside the app, or export the token manually.');
    process.exit(1);
  }
  console.log(`Using model: ${extractor.model} (${extractor.kind})`);

  const data = JSON.parse(readFileSync(obsPath, 'utf-8')) as { signals?: ObservationSignal[] };
  const signals = data.signals ?? [];

  const echoes = signals.filter((s) => {
    const excerpt = s.conversation?.excerpt ?? '';
    return isEcho(s.summary, excerpt);
  });

  console.log(`${signals.length} total observations, ${echoes.length} flagged as echoes.`);
  if (echoes.length === 0) {
    console.log('Nothing to rewrite.');
    return;
  }

  // Backup
  const backupPath = obsPath + `.backup-${Date.now()}`;
  copyFileSync(obsPath, backupPath);
  console.log(`Backup written: ${backupPath}`);

  const messages = buildMessageIndex(jsonlPath);
  console.log(`Loaded ${messages.size} messages from session.jsonl`);

  let rewritten = 0;
  let skipped = 0;
  let failed = 0;

  for (const obs of echoes) {
    const fromId = obs.conversation?.messageRange?.from;
    if (!fromId) { failed++; continue; }
    const msg = messages.get(fromId);
    if (!msg || !msg.content) {
      console.warn(`  Source message ${fromId} not found, skipping ${obs.id}`);
      failed++;
      continue;
    }

    const userPrompt = `Original ${obs.conversation?.actor ?? 'user'} message [${msg.id}]:

${msg.content.slice(0, 4000)}

Current (broken) summary: ${obs.summary}
Current salience: ${obs.salience ?? '?'}

Rewrite as a proper extracted fact, or skip.`;

    const raw = await callExtractor(extractor, buildSystemPrompt(), userPrompt);
    if (!raw) {
      console.warn(`  LLM call failed for ${obs.id}`);
      failed++;
      continue;
    }
    const parsed = parseRewriteResponse(raw);
    if (!parsed) {
      console.warn(`  Could not parse LLM response for ${obs.id}: ${raw.slice(0, 100)}`);
      failed++;
      continue;
    }
    if (parsed.skip) {
      skipped++;
      // Mark for removal
      obs.summary = '__REMOVE__';
      continue;
    }
    if (parsed.summary) {
      const oldSummary = obs.summary.slice(0, 80);
      obs.summary = parsed.summary;
      if (parsed.salience) obs.salience = parsed.salience;
      rewritten++;
      console.log(`  ✓ ${obs.id}: "${oldSummary}…" → "${parsed.summary.slice(0, 80)}"`);
    }
  }

  // Drop entries marked for removal
  const cleaned = signals.filter((s) => s.summary !== '__REMOVE__');

  writeFileSync(obsPath, JSON.stringify({ signals: cleaned }, null, 2) + '\n', 'utf-8');

  // Touch the watermark file so the renderer's file-watcher fires and
  // the observations viewer re-fetches the rewritten data. The watermark
  // content stays unchanged — only mtime is bumped.
  const watermarkPath = join(sessionDir, 'meta', 'observation-watermark.json');
  if (existsSync(watermarkPath)) {
    try {
      const now = new Date();
      utimesSync(watermarkPath, now, now);
    } catch {
      // Non-fatal — user can click Refresh manually.
    }
  }

  console.log(`\nDone:
  Rewritten: ${rewritten}
  Skipped (dropped): ${skipped}
  Failed (kept original): ${failed}
  Final count: ${cleaned.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
