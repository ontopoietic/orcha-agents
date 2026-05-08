#!/usr/bin/env npx tsx
/**
 * Orcha Observer — PreCompact Command-Action
 *
 * Triggered by automations.json PreCompact hook via buildSdkHooks().
 * Reads new messages since watermark, extracts structured signals using
 * the same LLM pattern Mastra observational-memory uses (Pivotal /
 * Question / Context with strict assertion-vs-question discipline),
 * writes them to the ledger, updates watermark.
 *
 * Resolution order for the session being observed:
 *   1. CLI arg
 *   2. CRAFT_SESSION_ID env (set by AutomationSystem.buildSdkHooks)
 *   3. Auto-detect most recent session under sessions/
 *
 * Resolution order for the LLM extractor:
 *   1. ORCHA_OBSERVER_PROVIDER + ORCHA_OBSERVER_API_KEY env (explicit override)
 *   2. ANTHROPIC_API_KEY (default Anthropic, Haiku 4.5)
 *   3. Fallback: pattern-only extraction (logs a warning)
 *
 * Called automatically by the SDK before compaction via buildSdkHooks().
 * stdout is returned as the hook "reason" visible to the agent.
 */

import {
  readWatermark,
  writeWatermark,
  messagesSinceWatermark,
  readAllMessages,
  type ObservableMessage,
  type ObservationWatermark,
} from '../packages/shared/src/sessions/observation-watermark.ts';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ============================================================================
// Session Auto-Detection
// ============================================================================

/**
 * Find the most recently active session by scanning sessions/ directories.
 * Looks for the session.jsonl with the newest mtime.
 * Returns the absolute session directory path, or null.
 */
function findMostRecentSession(): string | null {
  // workspace root = cwd (set by buildSdkHooks)
  const workspaceRoot = process.cwd();
  const sessionsDir = join(workspaceRoot, 'sessions');

  if (!existsSync(sessionsDir)) return null;

  let newestDir: string | null = null;
  let newestMtime = 0;

  try {
    const entries = readdirSync(sessionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const jsonlPath = join(sessionsDir, entry.name, 'session.jsonl');
      if (!existsSync(jsonlPath)) continue;

      try {
        const stat = statSync(jsonlPath);
        if (stat.mtimeMs > newestMtime) {
          newestMtime = stat.mtimeMs;
          newestDir = join(sessionsDir, entry.name);
        }
      } catch {
        // Skip inaccessible files
      }
    }
  } catch {
    return null;
  }

  return newestDir;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  // Resolution order:
  //   1. Explicit CLI arg
  //   2. CRAFT_SESSION_ID env (set by AutomationSystem.buildSdkHooks)
  //   3. Auto-detect most recently active session (last-resort fallback)
  let sessionDir = process.argv[2];

  if (!sessionDir && process.env.CRAFT_SESSION_ID) {
    const root = process.env.CRAFT_WORKSPACE_ROOT ?? process.cwd();
    sessionDir = join(root, 'sessions', process.env.CRAFT_SESSION_ID);
  }

  if (!sessionDir) {
    const detected = findMostRecentSession();
    if (!detected) {
      console.log('Observer: No active session found.');
      return;
    }
    sessionDir = detected;
  }

  const expandedDir = sessionDir.replace(/^~/, process.env.HOME || '~');
  const jsonlPath = join(expandedDir, 'session.jsonl');

  if (!existsSync(jsonlPath)) {
    console.log('Observer: No session.jsonl found, skipping.');
    return;
  }

  // 1. Read watermark
  const watermark = readWatermark(expandedDir);

  // 2. Read new messages
  const messages = watermark
    ? messagesSinceWatermark(jsonlPath, watermark.lastObservedMessageId)
    : readAllMessages(jsonlPath).slice(-50); // First run: last 50 messages

  if (messages.length === 0) {
    console.log('Observer: No new messages since watermark.');
    return;
  }

  // 3. Extract observations — LLM-first, pattern fallback
  const observations = await extractObservationsViaLlm(messages);

  if (observations.length === 0) {
    console.log('Observer: No extractable observations found.');
    return;
  }

  // 4. Read session header for anchor info
  const header = readSessionId(jsonlPath);
  const sessionId = header?.id || 'unknown';
  const anchors = header?.anchors || [];

  // 5. Write signals to ledger
  const ledgerPath = findLedgerPath(expandedDir);
  const signalCount = writeSignalsToLedger(ledgerPath, observations, sessionId, anchors, messages);

  // 6. Update watermark
  const lastMessage = messages[messages.length - 1];
  const newWatermark: ObservationWatermark = {
    sessionId,
    lastObservedMessageId: lastMessage.id,
    lastObservedAt: new Date().toISOString(),
    observedCount: (watermark?.observedCount ?? 0) + messages.length,
    lastSignalCount: signalCount,
  };
  writeWatermark(expandedDir, newWatermark);

  // 7. Report summary (visible to agent as hook reason)
  const pivotal = observations.filter(o => o.salience === 'pivotal').length;
  const question = observations.filter(o => o.salience === 'question').length;
  const context = observations.filter(o => o.salience === 'context').length;

  console.log(
    `Observer: Extracted ${signalCount} signals from ${messages.length} messages.\n` +
    `  🔴 ${pivotal} pivotal | 🟡 ${question} questions | 🟢 ${context} context\n` +
    `  Watermark: ${lastMessage.id.substring(0, 30)}...\n` +
    `  Ledger: ${ledgerPath}`
  );
}

// ============================================================================
// Observation Types
// ============================================================================

interface Observation {
  summary: string;
  salience: 'pivotal' | 'question' | 'context';
  actor: 'user' | 'agent';
  messageRange: { from: string; to: string };
  excerpt: string;
}

// ============================================================================
// LLM-Based Extraction (primary path — Mastra observational-memory pattern)
// ============================================================================

interface LlmExtractor {
  /** API endpoint, e.g. 'https://api.anthropic.com/v1/messages' */
  endpoint: string;
  /** Bearer token for the LLM provider */
  apiKey: string;
  /** Model id, e.g. 'claude-haiku-4-5' */
  model: string;
  /** Provider type — controls request shape */
  provider: 'anthropic';
  /** Optional API version header */
  apiVersion?: string;
}

/**
 * Resolve which LLM to use for extraction. Returns null if no credentials
 * are available — caller falls back to pattern matching with a warning.
 *
 * Env-var contract (in priority order):
 *   ORCHA_OBSERVER_PROVIDER=anthropic
 *   ORCHA_OBSERVER_API_KEY=sk-...
 *   ORCHA_OBSERVER_MODEL=claude-haiku-4-5
 *
 * Falls back to ANTHROPIC_API_KEY if the explicit override is not set.
 */
function resolveExtractor(): LlmExtractor | null {
  const provider = (process.env.ORCHA_OBSERVER_PROVIDER ?? 'anthropic').toLowerCase();
  const apiKey = process.env.ORCHA_OBSERVER_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  if (provider === 'anthropic') {
    return {
      provider: 'anthropic',
      apiKey,
      model: process.env.ORCHA_OBSERVER_MODEL ?? 'claude-haiku-4-5',
      endpoint: 'https://api.anthropic.com/v1/messages',
      apiVersion: '2023-06-01',
    };
  }
  // Future: openai/gemini providers here.
  return null;
}

/**
 * Build the Mastra-style observer prompt. Discipline lines distilled from
 * Mastra's reference implementation — they materially affect quality.
 */
function buildObserverSystemPrompt(): string {
  return `You are an Observational Memory writer. Your job: read a slice of an ongoing conversation and emit a JSON list of structured observations that future turns of the assistant will read INSTEAD OF the raw messages.

Discipline (MUST follow):
1. CRITICAL: USER ASSERTIONS TAKE PRECEDENCE over user questions. If a user states a fact, decision, or constraint, that is a "pivotal" observation. If the user merely asks something, that is a "question".
2. Distinguish assertions from questions. "Use feature branches" is pivotal. "Should we use feature branches?" is a question.
3. Represent state changes as overrides, not appends. If a user switches from option A to option B, write the new state, not the history.
4. Use precise verbs. "Subscribed to channel X" beats "got channel X".
5. Split multiple events into separate observations.
6. Time-anchor every observation: include a short bracketed reference like [user, msg-abc] so later turns can locate the source.
7. Do not invent facts. If a turn is ambiguous, skip it rather than guess.
8. Salience taxonomy:
   - "pivotal" 🔴: user assertions, decisions, constraints, corrections, schema/architecture choices
   - "question" 🟡: open questions awaiting answers
   - "context" 🟢: ambient state, completed steps, references — useful but not load-bearing

ABSOLUTE RULE — DO NOT ECHO:
The summary is NOT the message. It is a *fact extracted from* the message,
written from the outside, in the third person. NEVER paraphrase by reordering;
NEVER copy a sentence from the conversation as the summary; NEVER include
"the user said X" boilerplate — write the resulting state.

Hard target: summary ≤ 140 characters. Excerpt is the verbatim slice — that
is where the original wording lives. The summary must be DIFFERENT prose.

Examples:

  BAD (echo):
    summary: "The fix worked. Now the next thing: some edges reference back
              to previous nodes. These edges are still curved and run behind
              other nodes. They should go around the outside…"

  GOOD (extracted fact):
    summary: "Backward edges still route through other nodes; user wants
              outside routing"

  BAD (echo):
    summary: "Should we use Cloudflare D1 or Turso?"
  GOOD:
    summary: "Open question: D1 vs. Turso for the database"

  BAD (echo):
    summary: "Lass uns am Modul-System weitermachen"
  GOOD:
    summary: "Focus shifted to Modul-System feature"

If you cannot produce a summary that is genuinely shorter and reformulated
from the source, SKIP that turn — emitting an echo is worse than no entry.

Output: a JSON object { "observations": Observation[] } where Observation = {
  summary: string,                           // ≤ 140 chars, third-person fact
  salience: "pivotal" | "question" | "context",
  actor: "user" | "agent",
  messageRange: { from: string, to: string }, // message IDs from the input
  excerpt: string                            // ~120 chars verbatim from the source message
}.

Return ONLY valid JSON. No prose around it.`;
}

function buildObserverUserPrompt(messages: ObservableMessage[]): string {
  const lines = messages.map((m) => {
    const id = m.id;
    const actor = m.type === 'user' ? 'user' : m.type === 'assistant' ? 'agent' : m.type;
    const text = m.content.replace(/\s+/g, ' ').trim().slice(0, 1500);
    return `[${actor} ${id}] ${text}`;
  });
  return `Conversation slice (${messages.length} messages):\n\n${lines.join('\n')}\n\nReturn JSON.`;
}

interface AnthropicMessagesResponse {
  content?: Array<{ type: string; text?: string }>;
  error?: { message?: string };
}

async function callAnthropic(extractor: LlmExtractor, system: string, user: string): Promise<string | null> {
  const body = {
    model: extractor.model,
    max_tokens: 4096,
    temperature: 0.3,
    system,
    messages: [{ role: 'user', content: user }],
  };
  const res = await fetch(extractor.endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': extractor.apiKey,
      'anthropic-version': extractor.apiVersion ?? '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(`Observer: Anthropic call failed (${res.status}): ${text.slice(0, 200)}`);
    return null;
  }
  const json = (await res.json()) as AnthropicMessagesResponse;
  if (json.error) {
    console.warn(`Observer: Anthropic error: ${json.error.message ?? 'unknown'}`);
    return null;
  }
  // content is an array of blocks — concatenate all text blocks
  return (json.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .trim();
}

/**
 * Heuristic echo detector — true if the summary is essentially a copy of
 * the excerpt rather than an extracted fact. Catches the common LLM
 * failure mode where Haiku returns the user message as the "summary".
 *
 * Cheap normalization (lowercase, collapse whitespace) + prefix check on
 * 50 chars. False positives are acceptable — the viewer also flags any
 * surviving echoes visually.
 */
function isEcho(summary: string, excerpt: string): boolean {
  if (!summary || !excerpt) return false;
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  // Strip the salience prefix the LLM sometimes still adds.
  const s = norm(summary).replace(/^[^a-z0-9]*(user stated|user asked|observed):\s*/, '');
  const e = norm(excerpt);
  if (s.length < 30) return false;
  const head = s.slice(0, 50);
  // Either direction — summary inside excerpt OR excerpt inside summary
  return e.startsWith(head) || s.startsWith(e.slice(0, 50));
}

function parseObservationsJson(raw: string): Observation[] | null {
  // The model sometimes wraps JSON in code fences; strip them defensively.
  let text = raw.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
  }
  try {
    const parsed = JSON.parse(text) as { observations?: unknown };
    const arr = parsed.observations;
    if (!Array.isArray(arr)) return null;
    const result: Observation[] = [];
    for (const entry of arr) {
      if (!entry || typeof entry !== 'object') continue;
      const o = entry as Record<string, unknown>;
      const summary = typeof o.summary === 'string' ? o.summary : null;
      const salience = o.salience === 'pivotal' || o.salience === 'question' || o.salience === 'context' ? o.salience : null;
      const actor = o.actor === 'user' || o.actor === 'agent' ? o.actor : null;
      const range = o.messageRange as Record<string, unknown> | undefined;
      const from = range && typeof range.from === 'string' ? range.from : null;
      const to = range && typeof range.to === 'string' ? range.to : null;
      const excerpt = typeof o.excerpt === 'string' ? o.excerpt : '';
      if (!summary || !salience || !actor || !from || !to) continue;
      // Drop echoes — summary that mirrors the excerpt is not an
      // observation, it's a quote. The viewer flags surviving echoes
      // visually but we shouldn't waste storage on the obvious ones.
      if (isEcho(summary, excerpt)) continue;
      result.push({ summary, salience, actor, messageRange: { from, to }, excerpt });
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * Extract observations using an LLM. Falls back to pattern matching if no
 * credentials are configured or the call fails — keeps the observer running
 * even in degraded environments.
 */
async function extractObservationsViaLlm(messages: ObservableMessage[]): Promise<Observation[]> {
  // Filter out tool / system / error messages up-front so the LLM sees only
  // user/agent dialogue. Saves tokens and matches the prior pattern path.
  const dialogue = messages.filter((m) => (m.type === 'user' || m.type === 'assistant') && m.content.trim().length >= 10);
  if (dialogue.length === 0) return [];

  const extractor = resolveExtractor();
  if (!extractor) {
    console.warn('Observer: No LLM credentials (ORCHA_OBSERVER_API_KEY or ANTHROPIC_API_KEY). Falling back to pattern matching — quality will be lower.');
    return extractObservations(messages);
  }

  try {
    const raw = await callAnthropic(extractor, buildObserverSystemPrompt(), buildObserverUserPrompt(dialogue));
    if (!raw) {
      console.warn('Observer: Empty LLM response, falling back to pattern matching.');
      return extractObservations(messages);
    }
    const parsed = parseObservationsJson(raw);
    if (!parsed) {
      console.warn('Observer: Could not parse LLM JSON output, falling back to pattern matching.');
      return extractObservations(messages);
    }
    console.log(`Observer: LLM extracted ${parsed.length} observations from ${dialogue.length} messages (model=${extractor.model}).`);
    return parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Observer: LLM call threw, falling back to pattern matching: ${msg}`);
    return extractObservations(messages);
  }
}

// ============================================================================
// Pattern-Based Extraction (fallback only)
// ============================================================================

/**
 * Extract observations from messages using pattern matching.
 * Used only when no LLM credentials are configured.
 */
function extractObservations(messages: ObservableMessage[]): Observation[] {
  const observations: Observation[] = [];

  for (const msg of messages) {
    // Skip tool messages, system messages, errors
    if (msg.type !== 'user' && msg.type !== 'assistant') continue;

    // Skip empty or very short content
    const text = msg.content.trim();
    if (text.length < 10) continue;

    // Skip tool result content that's just "Running X..."
    if (text.startsWith('Running ') && text.length < 50) continue;
    if (text === 'Running Agent...') continue;

    const actor = msg.type === 'user' ? 'user' as const : 'agent' as const;

    // Pattern matching for user messages
    if (actor === 'user') {
      // Pivotal: User decisions, corrections, constraints
      const pivotalPatterns = [
        /(?:ich möchte|ich will|lass uns|let's|we should|ich entscheide|i decide|wir nutzen|we use|immer |always |niemals |never |nicht auf main|not on main|feature.branch)/i,
        /(?:stop|halt|falsch|wrong|nein das|no that|korrektur|correction|stimmt nicht|that's wrong|das ist falsch)/i,
        /(?:wichtig|important|Achtung|attention|merke dir|remember|notiere|note)/i,
        /(?:branch|commit|merge|deploy|push|release)/i,
        /(?:schema|architektur|architecture|datenmodell|data model)/i,
        /(?:deaktivier|disable|abschalten|turn off|ersetzt durch|replaced by)/i,
      ];

      // Question patterns
      const questionPatterns = [
        /\?/,
        /(?:soll |should |kann |can |wie |how |warum |why |was ist |what is |welche |which )/i,
        /(?:oder|or)\s+(soll|should|kann|can|ist|is)\s/i,
      ];

      for (const pattern of pivotalPatterns) {
        if (pattern.test(text)) {
          observations.push({
            summary: summarizePivotal(text),
            salience: 'pivotal',
            actor,
            messageRange: { from: msg.id, to: msg.id },
            excerpt: text.substring(0, 200),
          });
          break; // One observation per message
        }
      }

      if (observations.length > 0 && observations[observations.length - 1].messageRange.from === msg.id) {
        continue; // Already observed as pivotal
      }

      for (const pattern of questionPatterns) {
        if (pattern.test(text)) {
          observations.push({
            summary: summarizeQuestion(text),
            salience: 'question',
            actor,
            messageRange: { from: msg.id, to: msg.id },
            excerpt: text.substring(0, 200),
          });
          break;
        }
      }
    }

    // Agent messages: context-level observations for significant findings
    if (actor === 'agent' && text.length > 100) {
      // Look for agent conclusions, summaries, or key findings
      const agentPatterns = [
        /(?:zusammenfass|summary|ergebnis|result|fazit|conclusion|befund|finding)/i,
        /(?:empfehle|recommend|vorschlag|suggestion|plan|nächster schritt|next step)/i,
        /(?:implementier|implement|erstellt|created|geändert|modified|gelöst|resolved)/i,
      ];

      for (const pattern of agentPatterns) {
        if (pattern.test(text)) {
          observations.push({
            summary: summarizeContext(text),
            salience: 'context',
            actor,
            messageRange: { from: msg.id, to: msg.id },
            excerpt: text.substring(0, 200),
          });
          break;
        }
      }
    }
  }

  // Deduplicate: keep max 1 observation per message
  const seen = new Set<string>();
  return observations.filter(obs => {
    const key = obs.messageRange.from;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ============================================================================
// Summarizers
// ============================================================================

function summarizePivotal(text: string): string {
  const cleaned = text.replace(/\n+/g, ' ').trim();
  const prefix = '🔴 USER STATED: ';
  if (cleaned.length <= 180) return prefix + cleaned;
  return prefix + cleaned.substring(0, 177) + '...';
}

function summarizeQuestion(text: string): string {
  const cleaned = text.replace(/\n+/g, ' ').trim();
  const prefix = '🟡 USER ASKED: ';
  if (cleaned.length <= 180) return prefix + cleaned;
  return prefix + cleaned.substring(0, 177) + '...';
}

function summarizeContext(text: string): string {
  const cleaned = text.replace(/\n+/g, ' ').trim();
  const prefix = '🟢 OBSERVED: ';
  if (cleaned.length <= 180) return prefix + cleaned;
  return prefix + cleaned.substring(0, 177) + '...';
}

// ============================================================================
// Ledger Integration
// ============================================================================

interface LedgerData {
  rawSignals?: RawLedgerSignal[];
  [key: string]: unknown;
}

interface RawLedgerSignal {
  id: string;
  createdAt: string;
  source: string;
  summary: string;
  status: string;
  evidenceRefs?: string[];
  anchorRefs?: unknown[];
  conversation?: unknown;
  salience?: string;
}

function findLedgerPath(sessionDir: string): string {
  // First check session working directory for ledger
  // The ledger lives in the orcha project directory, not the session dir
  // But for observation purposes, we write to a session-local observations file
  return join(sessionDir, 'data', 'observations.json');
}

function writeSignalsToLedger(
  ledgerPath: string,
  observations: Observation[],
  sessionId: string,
  anchors: unknown[],
  messages: ObservableMessage[],
): number {
  const dir = dirname(ledgerPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Read existing
  let existing: RawLedgerSignal[] = [];
  if (existsSync(ledgerPath)) {
    try {
      const raw = readFileSync(ledgerPath, 'utf-8');
      const parsed = JSON.parse(raw);
      existing = parsed.signals || parsed || [];
    } catch {
      existing = [];
    }
  }

  // Build new signals
  const newSignals: RawLedgerSignal[] = observations.map((obs, i) => ({
    id: `obs-${Date.now()}-${i}`,
    createdAt: new Date().toISOString(),
    source: 'conversation',
    summary: obs.summary,
    status: 'raw',
    salience: obs.salience,
    anchorRefs: anchors.length > 0 ? anchors : undefined,
    conversation: {
      sessionId,
      messageRange: obs.messageRange,
      excerpt: obs.excerpt,
      actor: obs.actor,
    },
  }));

  // Write back
  const allSignals = [...existing, ...newSignals];
  writeFileSync(ledgerPath, JSON.stringify({ signals: allSignals }, null, 2) + '\n', 'utf-8');

  return newSignals.length;
}

// ============================================================================
// Helpers
// ============================================================================

function readSessionId(jsonlPath: string): { id?: string; anchors?: unknown[] } | null {
  try {
    const content = readFileSync(jsonlPath, 'utf-8');
    const firstNewline = content.indexOf('\n');
    const firstLine = firstNewline > 0 ? content.slice(0, firstNewline) : content;
    return JSON.parse(firstLine);
  } catch {
    return null;
  }
}

// Run
main().catch(err => {
  console.error('Observer error:', err);
  process.exit(1);
});
