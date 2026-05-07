#!/usr/bin/env npx tsx
/**
 * Orcha Observer — PreCompact Command-Action
 *
 * Triggered by automations.json PreCompact hook via buildSdkHooks().
 * Reads new messages since watermark, extracts structured signals
 * (pattern-based, no LLM), writes them to the ledger, updates watermark.
 *
 * Usage:
 *   npx tsx scripts/orcha-observe.ts [session-dir]
 *
 * If no session-dir is provided, auto-detects the most recently active
 * session by scanning sessions/ for the newest session.jsonl.
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
    sessionDir = findMostRecentSession();
    if (!sessionDir) {
      console.log('Observer: No active session found.');
      return;
    }
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

  // 3. Extract observations
  const observations = extractObservations(messages);

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
// Pattern-Based Extraction
// ============================================================================

/**
 * Extract observations from messages using pattern matching.
 * No LLM — deterministic, fast, testable.
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
