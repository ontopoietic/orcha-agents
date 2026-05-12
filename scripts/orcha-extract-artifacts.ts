#!/usr/bin/env npx tsx
/**
 * Orcha Artifact Extractor — phase-bounded LLM extraction of Rahmen
 * artifacts (tradeoffs, options, constraints, decisions, risks, …) and
 * their relations into a typed subgraph.
 *
 * Phase A.2 step 2B. Called by orcha-episode-emit.ts at phase-close
 * boundary. Output JSON {nodes, edges} goes to stdout for the emitter
 * to consume.
 *
 * CLI:
 *   npx tsx scripts/orcha-extract-artifacts.ts <sessionDir>
 *     --start-msg <id> --end-msg <id>
 *
 * Env (auth, mirrored from orcha-observe.ts / orcha-reflect.ts):
 *   ORCHA_ARTIFACT_EXTRACTOR_MODEL  default claude-haiku-4-5-20251001
 *   CLAUDE_CODE_OAUTH_TOKEN         OAuth path (preferred when present)
 *   ANTHROPIC_API_KEY               API-key fallback
 *   ORCHA_ARTIFACT_EXTRACTOR_API_KEY  override for dedicated extractor key
 *
 * Exit codes:
 *   0  graph emitted to stdout (may be empty {nodes:[], edges:[]})
 *   1  bad args / missing session
 *   2  no auth + no fallback → empty graph emitted, code 0 still (caller
 *      can't tell "nothing found" from "no auth"; that's by design — the
 *      extractor is best-effort, never fatal for the episode write)
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isKnownArtifactType,
  isKnownRelationType,
  renderTaxonomyForPrompt,
  type ArtifactGraph,
  type ArtifactNode,
  type ArtifactEdge,
  type ArtifactConfidence,
} from '../packages/shared/src/sessions/index.ts';
import { loadObservationSignals } from '../packages/shared/src/sessions/observation-loader.ts';

// ============================================================================
// CLI
// ============================================================================

function usage(): never {
  console.error('Usage: orcha-extract-artifacts <sessionDir> --start-msg <id> --end-msg <id>');
  process.exit(1);
}

const args = process.argv.slice(2);
const sessionDir = args[0];
if (!sessionDir) usage();
const startIdx = args.indexOf('--start-msg');
const endIdx = args.indexOf('--end-msg');
const startMsg = startIdx >= 0 ? args[startIdx + 1] : undefined;
const endMsg = endIdx >= 0 ? args[endIdx + 1] : undefined;
if (!startMsg || !endMsg) usage();
if (!existsSync(sessionDir!)) {
  console.error(`[extract-artifacts] session dir not found: ${sessionDir}`);
  process.exit(1);
}

// ============================================================================
// Read phase content
// ============================================================================

interface JsonlMessage {
  id?: string;
  type?: string;
  content?: unknown;
  toolName?: string;
  toolResult?: unknown;
  timestamp?: number;
}

function readPhase(): { phaseText: string; observationsText: string } {
  const jsonlPath = join(sessionDir!, 'session.jsonl');
  const lines = existsSync(jsonlPath)
    ? readFileSync(jsonlPath, 'utf-8').split('\n').filter(Boolean).slice(1)
    : [];
  const phaseLines: string[] = [];
  const phaseMsgIds = new Set<string>();
  let inPhase = false;
  for (const line of lines) {
    let m: JsonlMessage;
    try { m = JSON.parse(line) as JsonlMessage; } catch { continue; }
    if (!m.id) continue;
    if (m.id === startMsg) inPhase = true;
    if (inPhase) {
      phaseMsgIds.add(m.id);
      const role = m.type === 'user' ? 'user'
        : m.type === 'assistant' ? 'assistant'
        : m.type === 'tool' ? `tool:${m.toolName ?? '?'}` : null;
      if (role) {
        const text = extractText(m).slice(0, 1500);
        if (text) phaseLines.push(`[${m.id}] ${role}: ${text}`);
      }
    }
    if (m.id === endMsg) break;
  }

  // Canonical post Plan A/C: read observations.md + evidence sidecar (with
  // legacy JSON fallback baked into the loader).
  const sigs = loadObservationSignals(sessionDir!);
  const obsLines: string[] = [];
  for (const s of sigs) {
    const r = s.conversation?.messageRange;
    const inWindow = (r?.from && phaseMsgIds.has(r.from)) || (r?.to && phaseMsgIds.has(r.to));
    if (!inWindow) continue;
    obsLines.push(`[${s.salience ?? 'context'}] ${s.summary}`);
  }
  return {
    phaseText: phaseLines.join('\n').slice(0, 30_000),
    observationsText: obsLines.join('\n').slice(0, 6000),
  };
}

function extractText(m: JsonlMessage): string {
  const c = m.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) {
    return c
      .map((b) => {
        const block = b as Record<string, unknown>;
        if (block.type === 'text' && typeof block.text === 'string') return block.text;
        return '';
      })
      .filter(Boolean).join(' ').trim();
  }
  if (typeof m.toolResult === 'string') return m.toolResult.trim();
  return '';
}

// ============================================================================
// Auth resolution (same shape as orcha-reflect.ts)
// ============================================================================

type ExtractorMode =
  | { kind: 'cli'; cliPath: string; model: string }
  | { kind: 'api'; apiKey: string; model: string; endpoint: string; apiVersion: string };

function findClaudeBinary(): string | null {
  const appRoot = process.env.CRAFT_APP_ROOT;
  const candidates: string[] = [];
  if (appRoot) {
    candidates.push(
      join(appRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-darwin-arm64', 'claude'),
      join(appRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-binary', 'claude'),
    );
  }
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

function resolveExtractor(): ExtractorMode | null {
  const model = process.env.ORCHA_ARTIFACT_EXTRACTOR_MODEL ?? 'claude-haiku-4-5-20251001';
  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauth) {
    const cliPath = process.env.ORCHA_OBSERVER_CLI_PATH ?? findClaudeBinary();
    if (cliPath) return { kind: 'cli', cliPath, model };
  }
  const apiKey = process.env.ORCHA_ARTIFACT_EXTRACTOR_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    return {
      kind: 'api', apiKey, model,
      endpoint: 'https://api.anthropic.com/v1/messages',
      apiVersion: '2023-06-01',
    };
  }
  return null;
}

async function callClaudeCli(cliPath: string, model: string, system: string, user: string): Promise<string | null> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(
      cliPath,
      ['--print', '--model', model, '--append-system-prompt', system, '--disable-slash-commands', '--exclude-dynamic-system-prompt-sections', user],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '', err = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
    const t = setTimeout(() => { child.kill('SIGTERM'); resolve(null); }, 90_000);
    child.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out.trim() || null);
      else { console.warn(`[extract-artifacts] CLI exit ${code}: ${err.slice(0, 300)}`); resolve(null); }
    });
    child.on('error', () => { clearTimeout(t); resolve(null); });
  });
}

interface AnthropicMessagesResponse {
  content?: Array<{ type: string; text?: string }>;
  error?: { message?: string };
}

async function callApi(apiKey: string, model: string, endpoint: string, apiVersion: string, system: string, user: string): Promise<string | null> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': apiVersion },
    body: JSON.stringify({
      model, max_tokens: 4096, temperature: 0.2,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) {
    console.warn(`[extract-artifacts] API ${res.status}`);
    return null;
  }
  const json = (await res.json()) as AnthropicMessagesResponse;
  if (json.error) { console.warn(`[extract-artifacts] API error ${json.error.message}`); return null; }
  return (json.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string).join('\n').trim();
}

async function callExtractor(mode: ExtractorMode, system: string, user: string): Promise<string | null> {
  if (mode.kind === 'cli') return callClaudeCli(mode.cliPath, mode.model, system, user);
  return callApi(mode.apiKey, mode.model, mode.endpoint, mode.apiVersion, system, user);
}

// ============================================================================
// Output parsing + validation
// ============================================================================

export function parseExtractorOutput(raw: string): ArtifactGraph {
  let text = raw.trim();
  if (text.startsWith('```')) text = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { return { nodes: [], edges: [] }; }
  if (!parsed || typeof parsed !== 'object') return { nodes: [], edges: [] };
  const obj = parsed as Record<string, unknown>;
  const nodes: ArtifactNode[] = [];
  const edges: ArtifactEdge[] = [];

  if (Array.isArray(obj.nodes)) {
    for (const n of obj.nodes) {
      if (!n || typeof n !== 'object') continue;
      const o = n as Record<string, unknown>;
      const type = typeof o.type === 'string' ? o.type : null;
      const label = typeof o.label === 'string' ? o.label : null;
      if (!type || !label) continue;
      if (!isKnownArtifactType(type)) continue;
      const evidenceRaw = Array.isArray(o.evidence) ? o.evidence : [];
      const evidence = evidenceRaw.filter((x): x is string => typeof x === 'string');
      const conf: ArtifactConfidence =
        o.confidence === 'high' || o.confidence === 'medium' || o.confidence === 'low'
          ? o.confidence : 'low';
      const ref = typeof o.ref === 'string' ? o.ref : undefined;
      nodes.push({ type, label: label.trim(), evidence, confidence: conf, ...(ref ? { ref } : {}) });
    }
  }

  // Build a node-key set so we can drop edges referencing unknown nodes.
  const nodeKeys = new Set(nodes.map((n) => `${n.type}:${n.label.toLowerCase()}`));
  const refKeys = new Set(nodes.filter((n) => n.ref).map((n) => `ref:${n.ref}`));
  const isValidEndpoint = (v: string): boolean => {
    if (v.startsWith('ref:')) return refKeys.has(v);
    const idx = v.indexOf(':');
    if (idx < 0) return false;
    const t = v.slice(0, idx);
    const l = v.slice(idx + 1).toLowerCase();
    return nodeKeys.has(`${t}:${l}`);
  };

  if (Array.isArray(obj.edges)) {
    for (const e of obj.edges) {
      if (!e || typeof e !== 'object') continue;
      const o = e as Record<string, unknown>;
      const from = typeof o.from === 'string' ? o.from : null;
      const to = typeof o.to === 'string' ? o.to : null;
      const via = typeof o.via === 'string' ? o.via : null;
      if (!from || !to || !via) continue;
      if (!isKnownRelationType(via)) continue;
      if (!isValidEndpoint(from) || !isValidEndpoint(to)) continue;
      edges.push({ from, to, via });
    }
  }

  return { nodes, edges };
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const { phaseText, observationsText } = readPhase();
  if (!phaseText) {
    process.stdout.write(JSON.stringify({ nodes: [], edges: [] }));
    return;
  }

  const mode = resolveExtractor();
  if (!mode) {
    console.warn('[extract-artifacts] no auth (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY) — emitting empty graph');
    process.stdout.write(JSON.stringify({ nodes: [], edges: [] }));
    return;
  }

  const system = buildSystemPrompt();
  const user = buildUserPrompt(phaseText, observationsText);

  const raw = await callExtractor(mode, system, user);
  if (!raw) {
    process.stdout.write(JSON.stringify({ nodes: [], edges: [] }));
    return;
  }
  const graph = parseExtractorOutput(raw);
  process.stdout.write(JSON.stringify(graph));
}

function buildSystemPrompt(): string {
  return `You extract orcha framework artifacts (Rahmen-Artefakte) and their relations from a conversation phase.

${renderTaxonomyForPrompt()}

# Rules

1. Only extract artifacts that are clearly evidenced in the conversation. No speculation.
2. Each node must have evidence[] — message IDs (e.g. "msg-1778336894445-kre5qx") where the artifact appears.
3. confidence:
   - "high"   = multiple clear signals OR explicit naming
   - "medium" = one clear signal
   - "low"    = inferred from context, deserves human review
4. Edges connect extracted nodes only. Skip relations to artifacts you didn't extract.
5. Edge endpoints use the form "type:label" (case-insensitive label match) or "ref:<orcha-id>" if you know the orcha-CLI ID.
6. via must be one of the relation types listed above — exact lowercase string.
7. Output ONLY valid JSON. No prose, no markdown fences. Empty graph is OK: {"nodes": [], "edges": []}

# Output schema

{
  "nodes": [
    { "type": "tradeoff", "label": "Performance ↔ Lesbarkeit", "evidence": ["msg-1234"], "confidence": "high" }
  ],
  "edges": [
    { "from": "tradeoff:Performance ↔ Lesbarkeit", "to": "option:Cache-Layer", "via": "has_option" }
  ]
}`;
}

function buildUserPrompt(phaseText: string, observationsText: string): string {
  const obs = observationsText
    ? `\n\n# Already-distilled observations from this phase\n${observationsText}`
    : '';
  return `# Conversation phase

${phaseText}${obs}

Extract the Rahmen-subgraph. Return JSON only.`;
}

main().catch((err) => {
  console.error('[extract-artifacts] threw:', err);
  // Still emit valid empty graph so the caller doesn't choke.
  process.stdout.write(JSON.stringify({ nodes: [], edges: [] }));
});
