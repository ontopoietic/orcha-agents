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
import {
  parseObservationsMarkdown as parseMdBullets,
  resolveAnchorShortId,
} from '../packages/shared/src/sessions/observation-markdown-parser.ts';
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
    // Mastra is the DEFAULT observer path (env is opt-OUT). The read side
    // (prompt-builder.getSessionObservations + streaming tail) reads
    // observations.mastra.md with priority, so the write side must produce it
    // too — otherwise fresh observations land in the legacy ledger that the
    // agent never sees (the divergence that froze golden-stag's ledger for
    // days). Set ORCHA_OBSERVER_USE_MASTRA=0 only for legacy A/B comparison.
    if (process.env.ORCHA_OBSERVER_USE_MASTRA !== '0') {
      await runMastraObservation(expandedDir, jsonlPath);
    } else {
      await runObservation(expandedDir, jsonlPath);
    }
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
 * Writes to `data/observations.mastra.md` (kept separate from the existing
 * `data/observations.md` so both paths can coexist for A/B comparison).
 * The continuity hints from `<current-task>` / `<suggested-response>` are
 * persisted to `meta/observation-task.json` and overwritten each run.
 *
 * Append-only contract — matches Mastra: prior observations go into the
 * prompt verbatim with "Do not repeat these" guidance; the LLM emits only
 * new bullets which we concatenate onto the file.
 *
 * Switch on with `ORCHA_OBSERVER_USE_MASTRA=1`.
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

  // 2. Resolve extractor up front — same auth for every chunk
  const extractor = resolveExtractor();
  if (!extractor) {
    console.warn('Observer[mastra]: No LLM auth — aborting (no pattern fallback in Mastra path).');
    return;
  }

  // 3. Chunk the slice so each LLM call sees ≤OBSERVER_MAX_TOKENS_PER_BATCH of
  // NEW content. Mastra's analogue: `maxTokensPerBatch: 10_000`. Chunking
  // happens BEFORE dialogue filtering so the watermark advances by a
  // contiguous message range each iteration (incl. tool calls that sit
  // between user+assistant turns).
  const chunks = chunkMessagesByTokens(slice, OBSERVER_MAX_TOKENS_PER_BATCH);
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
      runningWatermark = advanceMastraWatermark(expandedDir, jsonlPath, chunk, runningWatermark, 0);
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
    const raw = await callExtractor(extractor, system, user);
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
      runningWatermark = advanceMastraWatermark(expandedDir, jsonlPath, chunk, runningWatermark, 0);
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
    runningWatermark = advanceMastraWatermark(expandedDir, jsonlPath, chunk, runningWatermark, bulletCount);
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

async function runObservation(expandedDir: string, jsonlPath: string): Promise<void> {
  const initialWatermark = readWatermark(expandedDir);

  // Slice = new messages since watermark; allMessages = anchor scope for the
  // LLM (it may keep older bullets whose anchors live before the watermark).
  // First run: slice equals the entire conversation.
  const allMessages = readAllMessages(jsonlPath);
  const slice = initialWatermark
    ? messagesSinceWatermark(jsonlPath, initialWatermark.lastObservedMessageId)
    : allMessages;

  if (slice.length === 0) {
    console.log('Observer: No new messages since watermark.');
    return;
  }

  const header = readSessionId(jsonlPath);
  const sessionId = header?.id || 'unknown';
  const anchors = header?.anchors || [];

  // Chunk the slice (Mastra `maxTokensPerBatch` analogue). Each chunk feeds
  // ≤OBSERVER_MAX_TOKENS_PER_BATCH of NEW content into one LLM call. Between
  // chunks we re-load the prior narrative because each chunk just wrote to
  // the ledger.
  const chunks = chunkMessagesByTokens(slice, OBSERVER_MAX_TOKENS_PER_BATCH);

  let runningWatermark: ObservationWatermark | null = initialWatermark;
  let totalSignals = 0;
  let totalPivotal = 0;
  let totalQuestion = 0;
  let totalContext = 0;
  let mdLedgerPath: string | null = null;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkLabel = `chunk ${i + 1}/${chunks.length}`;

    const priorNarrative = loadObservationsMd(expandedDir);
    const priorBulletCount = countBullets(priorNarrative);

    const { observations, fromLlm, rawNarrative } =
      await extractObservationsViaLlm(chunk, allMessages, priorNarrative);

    let signalCount = 0;
    if (observations.length > 0) {
      const runCreatedAt = new Date().toISOString();
      const wouldRegress = priorBulletCount > 0 && observations.length * 2 < priorBulletCount;
      if (fromLlm && !wouldRegress && rawNarrative) {
        writeMarkdownLedgerReplace(expandedDir, observations, rawNarrative, runCreatedAt, anchors);
      } else {
        if (fromLlm && wouldRegress) {
          console.warn(`Observer: ${chunkLabel} LLM emitted ${observations.length} bullets but prior had ${priorBulletCount} — appending instead of replacing to avoid regression.`);
        }
        writeMarkdownLedger(expandedDir, observations, runCreatedAt, anchors);
      }
      mdLedgerPath = findMarkdownLedgerPath(expandedDir);
      signalCount = observations.length;
      totalSignals += signalCount;
      totalPivotal += observations.filter(o => o.salience === 'pivotal').length;
      totalQuestion += observations.filter(o => o.salience === 'question').length;
      totalContext += observations.filter(o => o.salience === 'context').length;
    } else {
      console.log(`Observer: ${chunkLabel} 0 observations — advancing watermark anyway to avoid reprocessing.`);
    }

    // Watermark advances ALWAYS, even on 0 observations — otherwise the same
    // slice gets re-analyzed on every trigger, burning tokens.
    const lastMessage = chunk[chunk.length - 1];
    const newWatermark: ObservationWatermark = {
      sessionId,
      lastObservedMessageId: lastMessage.id,
      lastObservedAt: new Date().toISOString(),
      observedCount: (runningWatermark?.observedCount ?? 0) + chunk.length,
      lastSignalCount: signalCount,
    };
    writeWatermark(expandedDir, newWatermark);
    runningWatermark = newWatermark;
  }

  const finalLastMessageId = runningWatermark?.lastObservedMessageId ?? slice[slice.length - 1].id;

  if (totalSignals === 0) {
    console.log(
      `Observer: Watermark advanced (0 signals across ${chunks.length} chunk(s), ${slice.length} messages).\n` +
      `  Watermark: ${finalLastMessageId.substring(0, 30)}...`
    );
    return;
  }

  console.log(
    `Observer: Extracted ${totalSignals} signals across ${chunks.length} chunk(s) from ${slice.length} messages.\n` +
    `  🔴 ${totalPivotal} pivotal | 🟡 ${totalQuestion} questions | 🟢 ${totalContext} context\n` +
    `  Watermark: ${finalLastMessageId.substring(0, 30)}...\n` +
    `  Ledger: ${mdLedgerPath ?? '(none)'}`
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

type ExtractorMode =
  | { kind: 'cli'; cliPath: string; model: string }
  | { kind: 'api'; apiKey: string; model: string; endpoint: string; apiVersion: string };

/**
 * Resolve which LLM path to use for extraction. Returns null if no auth
 * is available — caller falls back to pattern matching with a warning.
 *
 * Resolution order:
 *   1. CLI path: if CLAUDE_CODE_OAUTH_TOKEN is in env (Pro subscription /
 *      OAuth-authenticated parent process), spawn the bundled `claude`
 *      binary with --print. The CLI handles OAuth headers automatically.
 *      Most orcha-agents users land here because the Electron app uses
 *      OAuth, not API keys.
 *   2. API key path: if ANTHROPIC_API_KEY is set, use raw fetch. Useful
 *      for CI / scripted runs.
 *   3. null: caller falls back to pattern matching.
 *
 * Env vars consulted:
 *   CLAUDE_CODE_OAUTH_TOKEN    OAuth token (set by Electron app on spawn)
 *   ORCHA_OBSERVER_API_KEY     overrides ANTHROPIC_API_KEY for the observer
 *   ANTHROPIC_API_KEY          fallback API key
 *   ORCHA_OBSERVER_MODEL       model id; defaults to claude-sonnet-4-6
 *   ORCHA_OBSERVER_CLI_PATH    explicit override for the claude binary
 */
function resolveExtractor(): ExtractorMode | null {
  // Haiku 4.5 = our analogue to Mastra's gemini-2.5-flash default: fast enough
  // (~10-25s per call) that the slice can be chunked into ≤10k batches and the
  // whole observation completes inside the 60s killswitch.
  const model = process.env.ORCHA_OBSERVER_MODEL ?? 'claude-haiku-4-5-20251001';

  // CLI path takes precedence — the OAuth token is the most common auth in
  // orcha-agents and the CLI hides the header complexity.
  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauth) {
    const cliPath = process.env.ORCHA_OBSERVER_CLI_PATH ?? findClaudeBinary();
    if (cliPath) {
      return { kind: 'cli', cliPath, model };
    }
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

/**
 * Locate the bundled `claude` CLI binary. Looks in the most likely places
 * relative to CRAFT_APP_ROOT (set by the Electron main process) and falls
 * back to scanning the npm-installed sdk package.
 */
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
  // Process resourcesPath (packaged Electron) — claude binary lives in app bundle
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

/**
 * Build the Mastra-style observer prompt. Discipline lines distilled from
 * Mastra's reference implementation — they materially affect quality.
 *
 * Output format: Markdown bullets (NOT JSON). See
 * packages/shared/src/sessions/observation-format.md for the canonical spec.
 * Spike measurements (sessions/260511-swift-otter/data/spike-report.md)
 * showed ~70 % token reduction vs. JSON output at parity quality.
 */
function buildObserverSystemPrompt(): string {
  return `You are an Observational Memory writer maintaining a coherent NARRATIVE of an ongoing conversation. Future turns of the assistant will read THIS narrative INSTEAD OF the raw messages, so it must be self-sufficient and tell the story of the work — in temporal order, with enough depth that a reader who never saw the conversation can understand WHY each step happened.

You receive:
  (a) the CURRENT narrative (everything observed so far, grouped by \`# YYYY-MM-DD\` headers), and
  (b) NEW messages since the last run.
Your job is to emit the FULL updated narrative — extending the story with what the new slice added, AND revising/consolidating older bullets when the new slice resolves, supersedes, or clarifies them.

PRESERVE TEMPORAL TRUTH (CRITICAL — failure here breaks the entire narrative):
- KEEP every existing \`# YYYY-MM-DD\` date header EXACTLY as it appears.
- KEEP the \`HH:mm\` time prefix of every bullet you carry over from the prior narrative — verbatim. Do NOT re-stamp old bullets with the current time.
- ONLY new bullets (added because of the new slice) get today's date and a current-ish time.
- If you consolidate 3 older bullets into 1, the surviving bullet keeps the EARLIEST of their times under the EARLIEST of their date headers — never collapse it onto today.

Working-memory discipline (MUST follow):
1. Represent state changes as OVERRIDES, not appends. If the user switched from option A to option B, the bullet for A should be REMOVED or revised — do not keep both.
2. RESOLVE OPEN QUESTIONS. If an earlier 🟡 was answered later, replace it with a 🔴 capturing the resolution (anchor to the answer message; date/time = the answer, not now).
3. CONSOLIDATE conservatively. If three older bullets describe one decision arc, collapse them into one bullet plus 2–4 sub-bullets that retain the supporting facts (file paths, IDs, rationale). Do NOT collapse and lose detail.
4. Use precise verbs. "Subscribed to channel X" beats "got channel X".
5. Anchor every bullet: append \` {shortId}\` where shortId is the last 6 chars of the source msg-ID (e.g. msg-1778338128969-u5luxw → {u5luxw}). For consolidated bullets use the most representative anchor.
6. Do not invent facts. If a turn is ambiguous, skip it rather than guess.

SALIENCE — heuristic, no quotas. Ask: "Could a future agent re-derive this fact by reading the current code, DB, model files, or session state?"
   - 🔴 pivotal: NO — this is a stance, preference, decision rationale, semantic shift, user-stated constraint, or correction. Things future work must NOT contradict. Examples: "User mandates feature-branch workflow", "Decision: Constraint anchors at Option, not Trade-off (rationale: …)", "Risk/Chance is epistemic, not structural carrier".
   - 🟡 question: an open question awaiting an answer. Drop once answered (replace with 🔴 carrying the answer).
   - 🟢 context: YES — re-derivable from artifacts. Examples: "Migration 0082 applied", "Tests green", "File X edited", "Branch Y created", "CLI bug fixed (snake_case → camelCase)". These are the *footprints* of work; the *reasons* behind them are 🔴.
   The same session may legitimately produce many 🔴 if many semantic decisions happened. It may also produce few 🔴 and lots of 🟢 if it was mostly execution. Both are correct — match the actual content.

DEPTH OVER DENSITY for 🔴:
- Headline bullet stays ≤ 140 chars.
- 🔴 bullets that capture decisions or semantic shifts SHOULD have 2–4 sub-bullets (2-space indent, no emoji, no time, no anchor) with: rationale, what it replaces, affected files/IDs, follow-up implications. Without this depth, future agents cannot understand WHY.
- 🟢 bullets stay one-liners.

ABSOLUTE RULE — DO NOT ECHO:
The summary is NOT the message. It is a *fact extracted from* the message,
written from the outside, in the third person. NEVER paraphrase by reordering;
NEVER copy a sentence from the conversation as the summary; NEVER include
"the user said X" boilerplate — write the resulting state.

Hard target: summary text ≤ 140 characters (the part between the time and
the anchor). The original wording lives in the source — your job is to
extract the FACT, in different prose.

If you cannot produce a summary that is genuinely shorter and reformulated
from the source, SKIP that turn — emitting an echo is worse than no entry.

Examples:

  BAD (echo):
    - 🟡 14:30 The fix worked. Now the next thing: some edges reference back to previous nodes. These edges are still curved... {abc123}
  GOOD (extracted fact):
    - 🔴 14:30 Backward edges still route through other nodes; user wants outside routing {abc123}

  BAD (echo):
    - 🟡 14:30 Should we use Cloudflare D1 or Turso? {def456}
  GOOD:
    - 🟡 14:30 Open question: D1 vs. Turso for the database {def456}

  BAD (echo):
    - 🔴 14:30 Lass uns am Modul-System weitermachen {ghi789}
  GOOD:
    - 🔴 14:30 Focus shifted to Modul-System feature {ghi789}

OUTPUT FORMAT (strict):

Group observations by date with a \`# YYYY-MM-DD\` header. Within each date,
emit one bullet per observation. Optional sub-bullet (2-space indent, no
emoji, no time, no anchor) only if a detail semantically belongs to the
parent bullet.

FORBIDDEN OUTPUTS — these will be REJECTED by the parser:

  BAD (JSON — never do this):
    \`\`\`json
    [{ "date": "2026-05-09", "observations": [
      { "emoji": "🔴", "text": "...", "anchor": "u5luxw" }
    ]}]
    \`\`\`

  BAD (JSON without fences — also rejected):
    {"observations": [{"summary": "...", "salience": "pivotal"}]}

  BAD (code fence around Markdown — rejected):
    \`\`\`markdown
    # 2026-05-09
    - 🔴 14:49 ... {u5luxw}
    \`\`\`

  GOOD (plain Markdown, no fences, no JSON):
    # 2026-05-09
    - 🔴 14:49 User chose Rahmen-Graph as next work item over three alternatives {u5luxw}
    - 🔴 14:49 Architecture shift: trade-offs resolved only through contextualized options, not decontextualized {u5luxw}
      - Replaces the previous direct-resolution model (cf. §7 Z.531)
      - Affects view-model: resolutionSummariesByTradeOff added to expose the contextualized resolution
      - Implication: Drawer no longer fetches options independently, reads from summary
    - 🟢 15:02 Migrations 0082/0083 applied (synthesized enum + CHECK constraint) {ccc004}
    - 🟢 15:05 Tests green: 25 view-model tests, 51 total affected {ddd005}
    - 🔴 15:12 Decision: glow animation derived per-tradeoff from tension magnitude (rejects uniform variant) {bbb002}
      - Rationale: uniform glow loses the differentiation that motivated the visualization

    # 2026-05-10
    - 🔴 09:18 User mandates feature-branch workflow; never push to main {eee006}
      - Reason: prior incident where direct main-push broke deployment

The FIRST character of your response MUST be \`#\` (the date header) or \`-\` (a bullet).
Do NOT start with \`\`\`, do NOT start with \`{\`, do NOT start with \`[\`, do NOT start with prose.

Return ONLY the Markdown bullet list. No code fences, no prose around it, no JSON.`;
}

function buildObserverUserPrompt(messages: ObservableMessage[], priorNarrative: string): string {
  const lines = messages.map((m) => {
    const id = m.id;
    const actor = m.type === 'user' ? 'user' : m.type === 'assistant' ? 'agent' : m.type;
    const text = m.content.replace(/\s+/g, ' ').trim().slice(0, 1500);
    return `[${actor} ${id}] ${text}`;
  });
  const priorBlock = priorNarrative.trim().length > 0
    ? `CURRENT NARRATIVE (everything observed so far):\n\n${priorNarrative.trim()}\n\n`
    : `CURRENT NARRATIVE: (empty — this is the first observation run)\n\n`;
  return `${priorBlock}NEW MESSAGES since last run (${messages.length} messages):\n\n${lines.join('\n')}\n\nEmit the FULL updated narrative as Markdown bullets grouped by \`# YYYY-MM-DD\` headers. Preserve older bullets unless the new slice gives you a reason to revise/consolidate them. Add new bullets for the new messages. Resolve open questions when the new slice answered them. Return ONLY the Markdown bullet list. NO JSON. NO code fences. NO prose.`;
}

interface AnthropicMessagesResponse {
  content?: Array<{ type: string; text?: string }>;
  error?: { message?: string };
}

/**
 * Run the LLM via the bundled `claude` CLI in --print mode. The CLI
 * handles OAuth headers from CLAUDE_CODE_OAUTH_TOKEN automatically — no
 * raw API surface for us to get wrong.
 */
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
    // Per-call timeout: a single Haiku chunk should finish well inside 90s.
    // The OUTER killswitch (observation-watcher / observation-trigger) bounds
    // total wallclock across chunks. Env override for slow links.
    const llmTimeoutMs = (() => {
      const v = parseInt(process.env.ORCHA_OBSERVER_LLM_TIMEOUT_MS ?? '', 10);
      return Number.isFinite(v) && v > 0 ? v : 90_000;
    })();
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      console.warn(`Observer: claude CLI timed out after ${llmTimeoutMs}ms`);
      resolve(null);
    }, llmTimeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim() || null);
      } else {
        console.warn(`Observer: claude CLI exited ${code}: ${stderr.trim().slice(0, 300) || stdout.trim().slice(0, 300)}`);
        resolve(null);
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      console.warn(`Observer: claude CLI spawn error: ${err.message}`);
      resolve(null);
    });
  });
}

async function callAnthropicAPI(apiKey: string, model: string, endpoint: string, apiVersion: string, system: string, user: string): Promise<string | null> {
  const body = {
    model,
    max_tokens: 4096,
    // 0.3 was too deterministic — the model regressed to copy-paste.
    // Slightly higher temp encourages reformulation without going off-spec.
    temperature: 0.6,
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
    console.warn(`Observer: Anthropic call failed (${res.status}): ${text.slice(0, 200)}`);
    return null;
  }
  const json = (await res.json()) as AnthropicMessagesResponse;
  if (json.error) {
    console.warn(`Observer: Anthropic error: ${json.error.message ?? 'unknown'}`);
    return null;
  }
  return (json.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .trim();
}

async function callExtractor(mode: ExtractorMode, system: string, user: string): Promise<string | null> {
  if (mode.kind === 'cli') {
    return callClaudeCLI(mode.cliPath, mode.model, system, user);
  }
  return callAnthropicAPI(mode.apiKey, mode.model, mode.endpoint, mode.apiVersion, system, user);
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
  // Strip markdown noise *before* lowercasing/whitespace-collapse. Without
  // this, "Follow-ups …" (summary, after cleanSummary stripped **bold**)
  // never matches "**Follow-ups** …" (raw excerpt) and the echo slips through.
  const stripMd = (s: string) =>
    s
      .replace(/```[\s\S]*?```/g, ' ')        // fenced code blocks
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // markdown links → label
      .replace(/`([^`]+)`/g, '$1')             // inline code
      .replace(/\*\*([^*]+)\*\*/g, '$1')       // bold
      .replace(/\*([^*]+)\*/g, '$1')           // italic
      .replace(/^[ \t]*#+\s*/gm, '')           // heading markers
      .replace(/^[ \t]*>\s?/gm, '')            // blockquote markers (line-start)
      .replace(/\s>\s/g, ' ')                  // inline `>` separators (e.g. "Follow-ups > [#1]")
      .replace(/…/g, '');                   // ellipsis added by cleanSummary on truncate
  const norm = (s: string) => stripMd(s).toLowerCase().replace(/\s+/g, ' ').trim();
  // Strip the salience prefix the LLM sometimes still adds.
  const s = norm(summary).replace(/^[^a-z0-9]*(user stated|user asked|observed):\s*/, '');
  const e = norm(excerpt);
  if (s.length < 30) return false;
  const head = s.slice(0, 50);
  // Either direction — summary inside excerpt OR excerpt inside summary
  return e.startsWith(head) || s.startsWith(e.slice(0, 50));
}

/**
 * Parse the LLM's Markdown bullet output into Observation records.
 *
 * Resolves each bullet's anchor against the slice's source messages to fill
 * in messageRange + excerpt + actor. Bullets without a resolvable anchor are
 * skipped (logged) — we'd otherwise emit observations the UI can't link
 * back to anything. Echo-detected bullets are dropped.
 */
function parseObservationsMarkdown(
  raw: string,
  candidateMessages: ObservableMessage[],
): Observation[] | null {
  const bullets = parseMdBullets(raw);
  if (!bullets) return null;

  const result: Observation[] = [];
  for (const bullet of bullets) {
    const msg = bullet.anchorShortId
      ? resolveAnchorShortId(bullet.anchorShortId, candidateMessages)
      : null;
    if (!msg) {
      console.warn(
        `Observer: bullet anchor '${bullet.anchorShortId ?? '<missing>'}' did not match any source message — skipping: ${bullet.summary.slice(0, 80)}`,
      );
      continue;
    }
    const excerpt = msg.content.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (isEcho(bullet.summary, excerpt)) continue;

    const actor: 'user' | 'agent' = msg.type === 'user' ? 'user' : 'agent';
    result.push({
      summary: bullet.summary,
      salience: bullet.salience,
      actor,
      messageRange: { from: msg.id, to: msg.id },
      excerpt,
    });
  }
  return result;
}

/**
 * Extract observations using an LLM. Falls back to pattern matching if no
 * credentials are configured or the call fails — keeps the observer running
 * even in degraded environments.
 */
interface ExtractionResult {
  observations: Observation[];
  /** True iff observations came from a successful LLM call (= full narrative
   * rewrite). False for pattern fallback (= slice-only deltas). */
  fromLlm: boolean;
  /** Raw Markdown the LLM produced — preserved verbatim for replace-write so
   * the LLM's exact narrative shape (date groups, ordering, formatting) lands
   * in the ledger without round-tripping through our renderer. */
  rawNarrative?: string;
}

async function extractObservationsViaLlm(
  messages: ObservableMessage[],
  allSessionMessages: ObservableMessage[],
  priorNarrative: string,
): Promise<ExtractionResult> {
  // Filter out tool / system / error messages up-front so the LLM sees only
  // user/agent dialogue. Saves tokens and matches the prior pattern path.
  const dialogue = messages.filter((m) => (m.type === 'user' || m.type === 'assistant') && m.content.trim().length >= 10);
  if (dialogue.length === 0) return { observations: [], fromLlm: false };

  // Anchor candidates: the LLM may keep prior bullets (anchored to messages
  // outside this slice) — resolve against ALL session dialogue so they
  // survive instead of being silently dropped.
  const anchorCandidates = allSessionMessages.filter((m) => (m.type === 'user' || m.type === 'assistant') && m.content.trim().length >= 10);

  const extractor = resolveExtractor();
  if (!extractor) {
    console.warn('Observer: No LLM auth (CLAUDE_CODE_OAUTH_TOKEN, ORCHA_OBSERVER_API_KEY, or ANTHROPIC_API_KEY). Falling back to pattern matching — quality will be lower.');
    return { observations: extractObservations(messages), fromLlm: false };
  }

  try {
    const raw = await callExtractor(extractor, buildObserverSystemPrompt(), buildObserverUserPrompt(dialogue, priorNarrative));
    if (!raw) {
      console.warn('Observer: Empty LLM response, falling back to pattern matching.');
      return { observations: extractObservations(messages), fromLlm: false };
    }
    // Canonical path post Plan A/C: Markdown bullets. JSON output is no
    // longer accepted — if the LLM returns JSON, we surface that loudly and
    // fall back to pattern matching so the failure is visible upstream.
    const parsed = parseObservationsMarkdown(raw, anchorCandidates);
    if (!parsed) {
      const sample = raw.replace(/\s+/g, ' ').trim().slice(0, 400);
      console.warn(`Observer: LLM output is not parseable Markdown bullets, falling back to pattern matching. Sample: ${sample}`);
      return { observations: extractObservations(messages), fromLlm: false };
    }
    if (parsed.length === 0) {
      // Parser ran successfully but produced zero records. Two common causes:
      //   1) LLM returned valid Markdown bullets but anchors {shortId} didn't
      //      match any source-message id → all bullets skipped silently.
      //   2) LLM returned only a date header / prose / empty body.
      // Without dumping a sample we can't tell which — and the user just sees
      // "0 observations" with no recourse.
      const sample = raw.replace(/\s+/g, ' ').trim().slice(0, 600);
      const availableAnchors = anchorCandidates.slice(-20).map(m => m.id.slice(-6)).join(',');
      console.warn(
        `Observer: Parser produced 0 records despite raw output. ` +
        `Raw sample (600 chars): ${sample}\n` +
        `  Last 20 available anchors (tail of msg-IDs): ${availableAnchors}`,
      );
    }
    console.log(`Observer: LLM extracted ${parsed.length} observations from ${dialogue.length} messages (mode=${extractor.kind}, model=${extractor.model}).`);
    return { observations: parsed, fromLlm: true, rawNarrative: stripCodeFences(raw) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : '';
    console.warn(`Observer: LLM call threw (mode=${extractor.kind}, model=${extractor.model}), falling back to pattern matching: ${msg} ${stack}`);
    return { observations: extractObservations(messages), fromLlm: false };
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

    // Agent messages: skip in pattern fallback.
    //
    // The pattern path can only compress, not extract — and agent messages
    // tend to be long Markdown reports (summary blocks, file diffs, code
    // listings). Compressing those produces 140-char echoes that say
    // nothing the conversation tail won't show better. Empirically validated
    // against 260509-lively-carbon: every agent-context bullet from this
    // path was rejected as echo or read as noise.
    //
    // The LLM path still extracts agent observations correctly because it
    // understands intent. When the LLM path fails (auth/network), losing
    // those agent context-bullets is the right tradeoff vs. emitting
    // pseudo-extractions.
  }

  // Deduplicate: keep max 1 observation per message, drop echoes.
  // Pattern fallback compresses raw text rather than extracting facts, so
  // echo-detection catches the obvious "summary is a slice of the excerpt"
  // case the LLM path also guards against.
  const seen = new Set<string>();
  return observations.filter(obs => {
    const key = obs.messageRange.from;
    if (seen.has(key)) return false;
    if (isEcho(obs.summary, obs.excerpt)) return false;
    seen.add(key);
    return true;
  });
}

// ============================================================================
// Summarizers
// ============================================================================

/**
 * Sanitize a raw message into a cleaner one-line summary for the pattern
 * fallback. The pattern path can't actually *extract a fact* — it can only
 * compress. So we strip Markdown noise (links, code fences, headings) and
 * hard-cap at 140 chars to match the new format spec. The salience-emoji
 * prefix is NO LONGER prepended here — the renderer adds it at write time.
 */
function cleanSummary(text: string): string {
  let s = text;
  // Drop fenced code blocks entirely — they're never the load-bearing fact.
  s = s.replace(/```[\s\S]*?```/g, ' ');
  // Markdown links → just the label.
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Drop inline code backticks (keep content).
  s = s.replace(/`([^`]+)`/g, '$1');
  // Drop Markdown headings + emphasis markers.
  s = s.replace(/^#+\s*/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1');
  // Strip the legacy '🔴 USER STATED: ' / '🟡 USER ASKED:' / '🟢 OBSERVED:' presets
  // in case they survived from older summaries fed back through.
  s = s.replace(/^[🔴🟡🟢]\s*(USER (STATED|ASKED)|OBSERVED|AGENT NOTED):\s*/u, '');
  // Collapse whitespace.
  s = s.replace(/\s+/g, ' ').trim();
  // Hard cap matching the new format spec.
  if (s.length <= 140) return s;
  return s.slice(0, 137).trimEnd() + '…';
}

// Kept as thin wrappers so existing call sites compile; all three now emit
// the same shape — the bullet renderer adds the salience emoji.
function summarizePivotal(text: string): string { return cleanSummary(text); }
function summarizeQuestion(text: string): string { return cleanSummary(text); }
function summarizeContext(text: string): string { return cleanSummary(text); }

// ============================================================================
// Ledger Integration — canonical post Plan A/C: observations.md + sidecar
// ============================================================================

function findMarkdownLedgerPath(sessionDir: string): string {
  return join(sessionDir, 'data', 'observations.md');
}

function findEvidenceSidecarPath(sessionDir: string): string {
  return join(sessionDir, 'data', 'observations-evidence.json');
}

const SALIENCE_TO_EMOJI: Record<'pivotal' | 'question' | 'context', string> = {
  pivotal: '🔴',
  question: '🟡',
  context: '🟢',
};

function shortIdFromMsgId(id: string): string {
  if (!id) return '';
  const parts = id.split('-');
  const last = parts[parts.length - 1];
  return last && last.length > 0 ? last : id.slice(-6);
}

function localDateAndTime(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return { date, time };
}

function renderBullet(obs: Observation, createdAt: string): string {
  const { time } = localDateAndTime(createdAt);
  const emoji = SALIENCE_TO_EMOJI[obs.salience];
  const anchor = obs.messageRange?.from
    ? ` {${shortIdFromMsgId(obs.messageRange.from)}}`
    : '';
  return `- ${emoji} ${time} ${obs.summary}${anchor}`;
}

interface MarkdownBulletEntry {
  date: string;
  line: string;
}

/**
 * Parse an existing observations.md back into bullet+date entries so we
 * can merge new observations into the right date groups. Preserves bullets
 * verbatim (we don't re-format ones we didn't write).
 */
function parseExistingMarkdown(text: string): MarkdownBulletEntry[] {
  const entries: MarkdownBulletEntry[] = [];
  if (!text) return entries;
  let currentDate: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const dateMatch = /^# (\d{4}-\d{2}-\d{2})\s*$/.exec(rawLine);
    if (dateMatch) {
      currentDate = dateMatch[1] ?? null;
      continue;
    }
    if (rawLine.startsWith('- ') || rawLine.startsWith('  - ')) {
      if (currentDate) entries.push({ date: currentDate, line: rawLine });
    }
  }
  return entries;
}

function renderMarkdownLedger(entries: MarkdownBulletEntry[]): string {
  if (entries.length === 0) return '';
  // Group by date, sort dates descending (newest first), preserve insertion
  // order within each date.
  const groups = new Map<string, string[]>();
  for (const e of entries) {
    const list = groups.get(e.date) ?? [];
    list.push(e.line);
    groups.set(e.date, list);
  }
  const sortedDates = [...groups.keys()].sort((a, b) => b.localeCompare(a));
  const out: string[] = [];
  for (const date of sortedDates) {
    out.push(`# ${date}`);
    for (const line of groups.get(date) ?? []) out.push(line);
    out.push('');
  }
  return out.join('\n').trimEnd() + '\n';
}

interface EvidenceEntry {
  fullMessageId: string;
  messageRangeTo: string;
  excerpt: string;
  actor: 'user' | 'agent';
  createdAt: string;
  anchorRefs?: unknown[];
}

function writeMarkdownLedger(
  sessionDir: string,
  observations: Observation[],
  createdAt: string,
  anchors: unknown[],
): void {
  if (observations.length === 0) return;
  const mdPath = findMarkdownLedgerPath(sessionDir);
  const evidencePath = findEvidenceSidecarPath(sessionDir);
  const dir = dirname(mdPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // Build new bullet entries grouped by the observer-run timestamp (one
  // observer call → one date group; finer-grained per-observation dates
  // would require per-message timestamps we don't currently track here).
  const { date: runDate } = localDateAndTime(createdAt);
  const newEntries: MarkdownBulletEntry[] = observations.map((obs) => ({
    date: runDate,
    line: renderBullet(obs, createdAt),
  }));

  // Merge with existing
  let existing: MarkdownBulletEntry[] = [];
  if (existsSync(mdPath)) {
    try {
      existing = parseExistingMarkdown(readFileSync(mdPath, 'utf-8'));
    } catch {
      existing = [];
    }
  }
  const merged = [...existing, ...newEntries];
  writeFileSync(mdPath, renderMarkdownLedger(merged), 'utf-8');

  // Sidecar: anchor → evidence
  let sidecar: Record<string, EvidenceEntry> = {};
  if (existsSync(evidencePath)) {
    try {
      const raw = readFileSync(evidencePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') sidecar = parsed as Record<string, EvidenceEntry>;
    } catch {
      sidecar = {};
    }
  }
  for (const obs of observations) {
    const fromId = obs.messageRange?.from;
    if (!fromId) continue;
    const shortId = shortIdFromMsgId(fromId);
    sidecar[shortId] = {
      fullMessageId: fromId,
      messageRangeTo: obs.messageRange.to ?? fromId,
      excerpt: obs.excerpt,
      actor: obs.actor,
      createdAt,
      ...(anchors.length > 0 ? { anchorRefs: anchors } : {}),
    };
  }
  writeFileSync(evidencePath, JSON.stringify(sidecar, null, 2) + '\n', 'utf-8');
}

/**
 * Replace the ledger with the LLM's full updated narrative (Mastra-style
 * working-memory rewrite). The raw Markdown is written verbatim so the LLM's
 * date groups, ordering, and any consolidations land exactly as it produced
 * them. The sidecar is then refreshed with anchor evidence for every bullet
 * the parser recognized — old sidecar entries are kept (they may still be
 * referenced by archived bullets we just rewrote).
 */
function writeMarkdownLedgerReplace(
  sessionDir: string,
  observations: Observation[],
  rawNarrative: string,
  createdAt: string,
  anchors: unknown[],
): void {
  const mdPath = findMarkdownLedgerPath(sessionDir);
  const evidencePath = findEvidenceSidecarPath(sessionDir);
  const dir = dirname(mdPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const normalized = rawNarrative.trim().endsWith('\n') ? rawNarrative.trim() + '\n' : rawNarrative.trim() + '\n';
  writeFileSync(mdPath, normalized, 'utf-8');

  // Sidecar: merge — never drop existing anchors (the LLM may have referenced
  // an older message we also want evidence for; new observations also add
  // entries).
  let sidecar: Record<string, EvidenceEntry> = {};
  if (existsSync(evidencePath)) {
    try {
      const raw = readFileSync(evidencePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') sidecar = parsed as Record<string, EvidenceEntry>;
    } catch {
      sidecar = {};
    }
  }
  for (const obs of observations) {
    const fromId = obs.messageRange?.from;
    if (!fromId) continue;
    const shortId = shortIdFromMsgId(fromId);
    sidecar[shortId] = {
      fullMessageId: fromId,
      messageRangeTo: obs.messageRange.to ?? fromId,
      excerpt: obs.excerpt,
      actor: obs.actor,
      createdAt,
      ...(anchors.length > 0 ? { anchorRefs: anchors } : {}),
    };
  }
  writeFileSync(evidencePath, JSON.stringify(sidecar, null, 2) + '\n', 'utf-8');
}

/** Read observations.md for narrative-context injection. Returns '' if absent. */
function loadObservationsMd(sessionDir: string): string {
  const p = findMarkdownLedgerPath(sessionDir);
  if (!existsSync(p)) return '';
  try { return readFileSync(p, 'utf-8'); } catch { return ''; }
}

/** Count top-level bullets in a Markdown narrative (for regression safety). */
function countBullets(md: string): number {
  if (!md) return 0;
  let n = 0;
  for (const line of md.split(/\r?\n/)) {
    if (/^- (🔴|🟡|🟢)/.test(line)) n++;
  }
  return n;
}

/** Strip a leading/trailing ```markdown fence if the LLM added one. */
function stripCodeFences(s: string): string {
  let t = s.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '').trim();
  }
  return t;
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
