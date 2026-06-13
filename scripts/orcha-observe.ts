#!/usr/bin/env npx tsx
/**
 * Orcha Observer — PreCompact Command-Action
 *
 * Triggered by automations.json PreCompact hook via buildSdkHooks().
 * Reads new messages since watermark, runs the vendored Mastra observational-
 * memory Observer over them (append-only ledger, anchored bullets), and
 * advances the watermark. Prompts/parsers live in
 * packages/shared/src/sessions/mastra-om/; LLM auth + calling lives in
 * scripts/lib/llm-extractor.ts — this script is orchestration only.
 *
 * Resolution order for the session being observed:
 *   1. CLI arg
 *   2. CRAFT_SESSION_ID env (set by AutomationSystem.buildSdkHooks)
 *   3. Auto-detect most recent session under sessions/
 *
 * LLM auth (see lib/llm-extractor.ts): CLAUDE_CODE_OAUTH_TOKEN → claude CLI,
 * else ORCHA_OBSERVER_API_KEY / ANTHROPIC_API_KEY → API. No pattern fallback —
 * without auth the run aborts and the watermark stays put.
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
import { resolveExtractor, callExtractor, type ExtractorMode } from './lib/llm-extractor.ts';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ============================================================================
// Running Marker — surfaces "observer is running" to the UI
// ============================================================================

/**
 * Marker file dropped into meta/ while the observer runs. The Electron
 * main-process watcher picks it up via fs.watch and emits a `running` flag
 * to the renderer (pill animation). Single source of truth — both the
 * token-trigger and the manual `runObserverNow` path spawn THIS script,
 * so we don't need a separate hook in each spawner.
 */
const RUNNING_MARKER = '.observer-running';

function writeRunningMarker(sessionDir: string): string | null {
  try {
    const metaDir = join(sessionDir, 'meta');
    if (!existsSync(metaDir)) mkdirSync(metaDir, { recursive: true });
    const markerPath = join(metaDir, RUNNING_MARKER);
    writeFileSync(markerPath, String(process.pid), 'utf-8');
    return markerPath;
  } catch {
    return null;
  }
}

function clearRunningMarker(markerPath: string | null): void {
  if (!markerPath) return;
  try { unlinkSync(markerPath); } catch { /* ignore */ }
}

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

  // Drop a running-marker so the renderer can light up its "observing" pill.
  // Cleared in a finally below — covers normal returns, throws, AND the
  // SIGTERM-on-timeout case (process.on('exit') below handles SIGTERM).
  const markerPath = writeRunningMarker(expandedDir);
  process.on('exit', () => clearRunningMarker(markerPath));
  process.on('SIGTERM', () => { clearRunningMarker(markerPath); process.exit(143); });
  process.on('SIGINT', () => { clearRunningMarker(markerPath); process.exit(130); });

  try {
    await runMastraObservation(expandedDir, jsonlPath);
  } finally {
    clearRunningMarker(markerPath);
  }
}

// ============================================================================
// Chunking — Mastra `maxTokensPerBatch` analogue
// ============================================================================

/**
 * Maximum NEW-content tokens we feed into a single Observer LLM call. Mastra's
 * `OBSERVATIONAL_MEMORY_DEFAULTS.observation.maxTokensPerBatch` is 10_000 —
 * we adopt the same default. With Haiku 4.5 this keeps each call ≤25s, so a
 * 30k-token slice splits into ~3 chunks that all finish inside the 60s
 * trigger killswitch with margin.
 *
 * Override with `ORCHA_OBSERVER_MAX_TOKENS_PER_BATCH`.
 */
const OBSERVER_MAX_TOKENS_PER_BATCH = (() => {
  const v = parseInt(process.env.ORCHA_OBSERVER_MAX_TOKENS_PER_BATCH ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 10_000;
})();

/**
 * Backlog (backfill) handling: when the Observer has been down for a while,
 * the un-observed slice is far larger than a normal live trigger (~24k-token
 * cadence). Feeding such a backlog through 10k chunks forces the LLM to
 * over-compress — decisions survive only as one-liners, their rationale is
 * lost. Empirically (session 260607, same prompt + model) 2.5k chunks kept
 * the substance that 10k chunks dropped (83 vs 24 bullets, rationale and
 * rejected alternatives intact).
 *
 * So: slices above OBSERVER_BACKLOG_THRESHOLD_TOKENS are treated as backlog
 * and chunked at OBSERVER_BACKFILL_TOKENS_PER_BATCH. Normal live slices keep
 * the Mastra-parity 10k. An explicit ORCHA_OBSERVER_MAX_TOKENS_PER_BATCH
 * override always wins over the adaptive choice.
 */
const OBSERVER_BACKFILL_TOKENS_PER_BATCH = (() => {
  const v = parseInt(process.env.ORCHA_OBSERVER_BACKFILL_TOKENS_PER_BATCH ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 2_500;
})();

/**
 * Above this slice size we assume a backlog. The live trigger fires at
 * ORCHA_OBSERVER_THRESHOLD_TOKENS (24k, see observation-trigger.ts), so a
 * normal live slice is ~24–30k; 2× the trigger means the Observer missed at
 * least one full cycle.
 */
const OBSERVER_BACKLOG_THRESHOLD_TOKENS = 48_000;

/** Per-LLM-call timeout; ORCHA_OBSERVER_LLM_TIMEOUT_MS overrides (default 90s). */
function resolveLlmTimeoutMs(): number {
  const v = parseInt(process.env.ORCHA_OBSERVER_LLM_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 90_000;
}

/** Pick the per-chunk token budget for this run (see backlog comment above). */
function resolveChunkTokens(slice: ObservableMessage[]): number {
  const explicit = parseInt(process.env.ORCHA_OBSERVER_MAX_TOKENS_PER_BATCH ?? '', 10);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const sliceTokens = Math.ceil(slice.reduce((n, m) => n + m.content.length, 0) / 4);
  if (sliceTokens > OBSERVER_BACKLOG_THRESHOLD_TOKENS) {
    console.log(
      `Observer: backlog slice (~${sliceTokens} tokens > ${OBSERVER_BACKLOG_THRESHOLD_TOKENS}) — using fine chunks (${OBSERVER_BACKFILL_TOKENS_PER_BATCH} tokens/batch).`,
    );
    return OBSERVER_BACKFILL_TOKENS_PER_BATCH;
  }
  return OBSERVER_MAX_TOKENS_PER_BATCH;
}

/**
 * Split a message slice into chunks whose cumulative content length stays
 * under `maxTokens` (chars/4 heuristic). Splits at message boundaries — a
 * single oversized message becomes its own chunk rather than being dropped.
 * The chunks preserve original order so the watermark advances by contiguous
 * ranges.
 */
function chunkMessagesByTokens(
  messages: ObservableMessage[],
  maxTokens: number,
): ObservableMessage[][] {
  if (messages.length === 0) return [];
  const maxChars = maxTokens * 4;
  const chunks: ObservableMessage[][] = [];
  let current: ObservableMessage[] = [];
  let currentChars = 0;
  for (const m of messages) {
    const len = m.content.length;
    if (current.length > 0 && currentChars + len > maxChars) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(m);
    currentChars += len;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ============================================================================
// Mastra-style Observer (vendored prompts/parsers, append-only)
// ============================================================================

/**
 * New Observer path that uses the vendored Mastra OM primitives.
 *
 * Writes to `data/observations.mastra.md` (the legacy `data/observations.md`
 * ledger is read-only history now — readers still merge it in, but nothing
 * writes it anymore).
 * The continuity hints from `<current-task>` / `<suggested-response>` are
 * persisted to `meta/observation-task.json` and overwritten each run.
 *
 * Append-only contract — matches Mastra: prior observations go into the
 * prompt verbatim with "Do not repeat these" guidance; the LLM emits only
 * new bullets which we concatenate onto the file.
 */
async function runMastraObservation(expandedDir: string, jsonlPath: string): Promise<void> {
  const {
    buildObserverPrompt,
    buildObserverSystemPrompt,
    parseObserverOutput,
    parseAnchoredBullets,
    ORCHA_ANCHOR_INSTRUCTION,
  } = await import('../packages/shared/src/sessions/mastra-om/index.ts');

  // 1. Watermark + message slice
  const initialWatermark = readWatermark(expandedDir);
  const allMessages = readAllMessages(jsonlPath);
  const slice = initialWatermark
    ? messagesSinceWatermark(jsonlPath, initialWatermark.lastObservedMessageId)
    : allMessages;
  if (slice.length === 0) {
    console.log('Observer[mastra]: No new messages since watermark.');
    return;
  }

  // 2. Resolve extractor up front — same auth for every chunk. Haiku 4.5 is
  // our analogue to Mastra's gemini-2.5-flash default: fast enough (~10-25s
  // per call) that chunked slices finish inside the trigger killswitch.
  const extractor: ExtractorMode | null = resolveExtractor({
    defaultModel: 'claude-haiku-4-5-20251001',
    modelEnvKeys: ['ORCHA_OBSERVER_MODEL'],
    apiKeyEnvKeys: ['ORCHA_OBSERVER_API_KEY'],
    logPrefix: 'Observer[mastra]',
  });
  if (!extractor) {
    console.warn('Observer[mastra]: No LLM auth — aborting (watermark not advanced).');
    return;
  }

  // 3. Chunk the slice so each LLM call sees a bounded amount of NEW content.
  // Mastra's analogue: `maxTokensPerBatch: 10_000`; backlog slices use finer
  // chunks (see resolveChunkTokens). Chunking happens BEFORE dialogue
  // filtering so the watermark advances by a contiguous message range each
  // iteration (incl. tool calls that sit between user+assistant turns).
  const chunks = chunkMessagesByTokens(slice, resolveChunkTokens(slice));
  const mastraLedgerPath = findMastraLedgerPath(expandedDir);
  // Anchor candidates: bullets may refer to messages BEFORE the watermark
  // (e.g. when consolidating across runs). Resolve against ALL dialogue.
  const anchorCandidates = allMessages.filter(
    (m) => (m.type === 'user' || m.type === 'assistant') && m.content.trim().length >= 10,
  );
  // Custom-instruction override: tells the LLM to append {shortId} per
  // bullet using the [#shortId] markers our formatMessagesForObserver puts
  // on each source message header. Keeps the vendored Mastra prompts intact.
  const system = buildObserverSystemPrompt({ instruction: ORCHA_ANCHOR_INSTRUCTION });

  let runningWatermark: ObservationWatermark | null = initialWatermark;
  let totalBullets = 0;
  let totalDialogue = 0;
  let lastCurrentTask: string | undefined;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkLabel = `chunk ${i + 1}/${chunks.length}`;

    // Filter to dialogue — empty payload is no observation (Mastra rule).
    const dialogue = chunk.filter(
      (m) => (m.type === 'user' || m.type === 'assistant') && m.content.trim().length >= 10,
    );
    if (dialogue.length === 0) {
      runningWatermark = advanceMastraWatermark(expandedDir, jsonlPath, chunk, runningWatermark, totalBullets);
      console.log(`Observer[mastra]: ${chunkLabel} no dialogue — watermark advanced (0 signals).`);
      continue;
    }
    totalDialogue += dialogue.length;

    // Re-load prior narrative + task between chunks — the previous chunk
    // already appended; the next call must see the updated state.
    const priorObservations = existsSync(mastraLedgerPath)
      ? tailTruncate(readFileSync(mastraLedgerPath, 'utf-8'), MASTRA_PREVIOUS_TOKENS_CHARS)
      : '';
    const wasTruncated =
      existsSync(mastraLedgerPath) &&
      readFileSync(mastraLedgerPath, 'utf-8').length > MASTRA_PREVIOUS_TOKENS_CHARS;
    const priorTask = readPriorTaskMeta(expandedDir);

    const user = buildObserverPrompt(priorObservations || undefined, dialogue, {
      priorCurrentTask: priorTask?.currentTask,
      priorSuggestedResponse: priorTask?.suggestedResponse,
      wasTruncated,
    });
    const raw = await callExtractor(extractor, system, user, {
      logPrefix: 'Observer[mastra]',
      // Per-call timeout: a single Haiku chunk should finish well inside 90s.
      // The OUTER killswitch (observation-watcher / observation-trigger)
      // bounds total wallclock across chunks. Env override for slow links.
      timeoutMs: resolveLlmTimeoutMs(),
      // 0.3 was too deterministic — the model regressed to copy-paste.
      // Slightly higher temp encourages reformulation without going off-spec.
      maxTokens: 4096,
      temperature: 0.6,
    });
    if (!raw) {
      console.warn(`Observer[mastra]: ${chunkLabel} empty LLM response — aborting chunk loop, watermark NOT advanced further.`);
      return;
    }

    const parsed = parseObserverOutput(raw);
    if (parsed.degenerate) {
      console.warn(`Observer[mastra]: ${chunkLabel} degenerate output — aborting chunk loop, watermark NOT advanced further.`);
      return;
    }
    const newObservations = parsed.observations.trim();
    if (!newObservations) {
      // The LLM ran on REAL dialogue (this chunk passed the dialogue filter
      // above) but returned no bullets. Under streaming replacement, advancing
      // the watermark past these messages without a ledger entry would erase
      // them: they fall out of the conversation tail (now ≤ watermark) yet are
      // absent from observations. So we append a placeholder coverage bullet
      // that records the reviewed span, preserving the invariant "everything
      // ≤ watermark is represented in the ledger" while still making forward
      // progress (no infinite reprocessing). True LLM FAILURES (empty/
      // degenerate raw output) are handled above and abort WITHOUT advancing.
      console.warn(
        `Observer[mastra]: ${chunkLabel} empty observation block on ${dialogue.length} dialogue msg(s) — writing placeholder coverage bullet. Sample: ${raw.trim().slice(0, 200)}`,
      );
      const placeholder = buildCoveragePlaceholder(dialogue);
      appendToMastraLedger(mastraLedgerPath, priorObservations, placeholder);
      runningWatermark = advanceMastraWatermark(expandedDir, jsonlPath, chunk, runningWatermark, totalBullets);
      continue;
    }

    appendToMastraLedger(mastraLedgerPath, priorObservations, newObservations);
    writePriorTaskMeta(expandedDir, {
      currentTask: parsed.currentTask,
      suggestedResponse: parsed.suggestedContinuation,
      threadTitle: parsed.threadTitle,
      updatedAt: new Date().toISOString(),
    });
    if (parsed.currentTask) lastCurrentTask = parsed.currentTask;

    // Parse anchored bullets, resolve each shortId against source messages,
    // and update the Mastra evidence sidecar. Bullets whose anchor cannot be
    // resolved are surfaced as warnings so we can tune the prompt — the
    // ledger keeps them anyway (they may still be readable to a human).
    const anchored = parseAnchoredBullets(newObservations);
    let resolvedAnchors = 0;
    let unresolvedAnchors = 0;
    const sidecarUpdate = buildMastraSidecarFromBullets(
      anchored,
      anchorCandidates,
      new Date().toISOString(),
    );
    resolvedAnchors = sidecarUpdate.resolved;
    unresolvedAnchors = sidecarUpdate.unresolved;
    if (Object.keys(sidecarUpdate.entries).length > 0) {
      writeMastraEvidenceSidecar(expandedDir, sidecarUpdate.entries);
    }
    if (unresolvedAnchors > 0) {
      console.warn(
        `Observer[mastra]: ${chunkLabel} ${unresolvedAnchors} bullet(s) with unresolved/missing anchor — UI back-link unavailable for those.`,
      );
    }

    const bulletCount = anchored.length || (newObservations.match(/^\s*[*\-]\s/gm) ?? []).length;
    totalBullets += bulletCount;
    // lastSignalCount carries the RUN-cumulative total, not this chunk's
    // count — otherwise a trailing no-dialogue chunk overwrites it with 0
    // and the UI badge reports "none extracted" for a productive run.
    runningWatermark = advanceMastraWatermark(expandedDir, jsonlPath, chunk, runningWatermark, totalBullets);
    console.log(
      `Observer[mastra]: ${chunkLabel} appended ${bulletCount} bullets (${resolvedAnchors} anchored, ${unresolvedAnchors} unanchored).`,
    );
  }

  console.log(
    `Observer[mastra]: appended ${totalBullets} bullets across ${chunks.length} chunk(s) ` +
      `(${totalDialogue} dialogue / ${slice.length} total messages).\n` +
      `  Ledger: ${mastraLedgerPath}\n` +
      `  Current-task: ${lastCurrentTask ? lastCurrentTask.slice(0, 120) : '(none)'}`,
  );
}

/**
 * Append the new observation block to the existing ledger. We don't try to
 * merge by date — Mastra's Observer already emits date headers, and the
 * ledger is read by the next Observer call verbatim, so concatenation is
 * sufficient. Successive same-day headers can be consolidated by the
 * Reflector later.
 */
/**
 * Build a minimal coverage placeholder block for a dialogue span the LLM
 * reviewed but produced no bullets for. Keeps the Mastra ledger lossless under
 * streaming replacement: the span is recorded as low-salience context rather
 * than silently dropped. Parser-safe (parse-ledger.ts tolerates a headerless,
 * timeless `* 🟢` bullet). The Reflector can later collapse these.
 */
function buildCoveragePlaceholder(dialogue: ObservableMessage[]): string {
  const last = dialogue[dialogue.length - 1];
  let timePart = '';
  if (last && Number.isFinite(last.timestamp)) {
    // Match the ledger's `(h:mm AM/PM)` convention so it groups cleanly.
    const t = new Date(last.timestamp).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    });
    timePart = `(${t}) `;
  }
  return `* 🟢 ${timePart}[${dialogue.length} message(s) reviewed, no individually salient signal — routine work, recorded for coverage]`;
}

function appendToMastraLedger(path: string, prior: string, newBlock: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!prior) {
    writeFileSync(path, newBlock.trim() + '\n', 'utf-8');
    return;
  }
  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const merged = existing.replace(/\s+$/, '') + '\n\n' + newBlock.trim() + '\n';
  writeFileSync(path, merged, 'utf-8');
}

function findMastraLedgerPath(sessionDir: string): string {
  return join(sessionDir, 'data', 'observations.mastra.md');
}

function findMastraEvidenceSidecarPath(sessionDir: string): string {
  return join(sessionDir, 'data', 'observations-evidence.mastra.json');
}

interface MastraEvidenceEntry {
  fullMessageId: string;
  excerpt: string;
  actor: 'user' | 'agent';
  createdAt: string;
}

/**
 * Resolve `{shortId}` anchors emitted by the LLM against the source messages
 * the slice was extracted from. Returns the new sidecar entries to merge in,
 * plus counters for diagnostic output.
 */
function buildMastraSidecarFromBullets(
  bullets: Array<{ anchorShortId: string | null; summary: string }>,
  candidates: ObservableMessage[],
  createdAt: string,
): { entries: Record<string, MastraEvidenceEntry>; resolved: number; unresolved: number } {
  const entries: Record<string, MastraEvidenceEntry> = {};
  let resolved = 0;
  let unresolved = 0;
  for (const bullet of bullets) {
    if (!bullet.anchorShortId) {
      unresolved++;
      continue;
    }
    const msg = candidates.find((m) => m.id.endsWith(`-${bullet.anchorShortId}`) || m.id.endsWith(bullet.anchorShortId!));
    if (!msg) {
      unresolved++;
      continue;
    }
    resolved++;
    entries[bullet.anchorShortId] = {
      fullMessageId: msg.id,
      excerpt: msg.content.replace(/\s+/g, ' ').trim().slice(0, 200),
      actor: msg.type === 'user' ? 'user' : 'agent',
      createdAt,
    };
  }
  return { entries, resolved, unresolved };
}

/**
 * Merge new evidence entries into the on-disk Mastra sidecar. Existing
 * entries are kept — historic anchors may still be referenced by older
 * bullets we haven't seen again this run.
 */
function writeMastraEvidenceSidecar(
  sessionDir: string,
  newEntries: Record<string, MastraEvidenceEntry>,
): void {
  const p = findMastraEvidenceSidecarPath(sessionDir);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  let existing: Record<string, MastraEvidenceEntry> = {};
  if (existsSync(p)) {
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf-8'));
      if (parsed && typeof parsed === 'object') existing = parsed as Record<string, MastraEvidenceEntry>;
    } catch {
      existing = {};
    }
  }
  const merged = { ...existing, ...newEntries };
  writeFileSync(p, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
}

function findPriorTaskMetaPath(sessionDir: string): string {
  return join(sessionDir, 'meta', 'observation-task.json');
}

interface PriorTaskMeta {
  currentTask?: string;
  suggestedResponse?: string;
  threadTitle?: string;
  updatedAt: string;
}

function readPriorTaskMeta(sessionDir: string): PriorTaskMeta | null {
  const p = findPriorTaskMetaPath(sessionDir);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    if (parsed && typeof parsed === 'object') return parsed as PriorTaskMeta;
    return null;
  } catch {
    return null;
  }
}

function writePriorTaskMeta(sessionDir: string, meta: PriorTaskMeta): void {
  const p = findPriorTaskMetaPath(sessionDir);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
}

/** Tail-truncate prior observations to ~2k tokens (Mastra default). */
const MASTRA_PREVIOUS_TOKENS_CHARS = 2_000 * 4;

function tailTruncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(s.length - maxChars);
}

function advanceMastraWatermark(
  expandedDir: string,
  jsonlPath: string,
  messages: ObservableMessage[],
  prior: ObservationWatermark | null,
  signalCount: number,
): ObservationWatermark | null {
  const header = readSessionId(jsonlPath);
  const sessionId = header?.id || 'unknown';
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage) return prior;
  const wm: ObservationWatermark = {
    sessionId,
    lastObservedMessageId: lastMessage.id,
    lastObservedAt: new Date().toISOString(),
    observedCount: (prior?.observedCount ?? 0) + messages.length,
    lastSignalCount: signalCount,
  };
  writeWatermark(expandedDir, wm);
  return wm;
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
