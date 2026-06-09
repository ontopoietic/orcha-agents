#!/usr/bin/env npx tsx
/**
 * Orcha Episode Emitter — L3 episode write for a closed phase.
 *
 * Phase A walking skeleton: deterministic summary (no LLM yet — that comes
 * in a follow-up). Reads observations.json, jsonl header, and the previous
 * episode's endMessageId to compute the active phase, then writes a new
 * episode JSON via packages/shared/src/sessions/episode.ts.
 *
 * CLI:
 *   npx tsx scripts/orcha-episode-emit.ts <sessionDir> <closeReason>
 *
 * closeReason ∈ session-done | anchor-change | idle-cutoff | manual.
 *
 * Exit codes:
 *   0  episode written
 *   1  bad args / missing session
 *   2  nothing to emit (no new messages since last episode)
 */

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  readEpisodeIndex,
  writeEpisode,
  type ArtifactGraph,
  type EpisodeAnchor,
  type EpisodeArtifact,
  type EpisodeCloseReason,
  type EpisodeOutcome,
} from '../packages/shared/src/sessions/episode.ts';
import { extractArtifactsFromMessages } from '../packages/shared/src/sessions/episode-extractors.ts';
import { loadObservationSignals } from '../packages/shared/src/sessions/observation-loader.ts';
import type { ObservationSignal } from '../packages/shared/src/sessions/observation-watermark.ts';

// ============================================================================
// CLI
// ============================================================================

function usage(): never {
  console.error('Usage: orcha-episode-emit <sessionDir> <closeReason>');
  console.error('  closeReason: session-done | anchor-change | idle-cutoff | manual');
  process.exit(1);
}

const sessionDir = process.argv[2];
const closeReasonRaw = process.argv[3];
if (!sessionDir || !closeReasonRaw) usage();

const validReasons: EpisodeCloseReason[] = [
  'session-done',
  'anchor-change',
  'idle-cutoff',
  'manual',
];
if (!validReasons.includes(closeReasonRaw as EpisodeCloseReason)) usage();
const closeReason = closeReasonRaw as EpisodeCloseReason;

if (!existsSync(sessionDir)) {
  console.error(`[episode] session dir not found: ${sessionDir}`);
  process.exit(1);
}

// ============================================================================
// Read session state
// ============================================================================

interface SessionHeader {
  id: string;
  workspaceRootPath?: string;
  workspaceId?: string;
  anchors?: EpisodeAnchor[];
  workingDirectory?: string;
}

interface JsonlMessage {
  id?: string;
  type?: string;
  timestamp?: number;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  content?: unknown;
}

function readSession(): { header: SessionHeader; messages: JsonlMessage[] } {
  const jsonlPath = join(sessionDir!, 'session.jsonl');
  if (!existsSync(jsonlPath)) {
    console.error(`[episode] session.jsonl missing at ${jsonlPath}`);
    process.exit(1);
  }
  const raw = readFileSync(jsonlPath, 'utf-8');
  const lines = raw.split('\n').filter(Boolean);
  if (lines.length === 0) {
    console.error('[episode] session.jsonl is empty');
    process.exit(1);
  }
  let header: SessionHeader;
  try {
    header = JSON.parse(lines[0]!) as SessionHeader;
  } catch (err) {
    console.error('[episode] header parse failed:', err);
    process.exit(1);
  }
  const messages: JsonlMessage[] = [];
  for (const line of lines.slice(1)) {
    try {
      messages.push(JSON.parse(line) as JsonlMessage);
    } catch {
      // skip corrupted lines
    }
  }
  return { header, messages };
}

function readObservations(): ObservationSignal[] {
  // Canonical post Plan A/C: read from observations.md + evidence sidecar.
  // Falls back to legacy observations.json for un-migrated sessions.
  return loadObservationSignals(sessionDir!);
}

// ============================================================================
// Phase boundary computation
// ============================================================================

function findPhaseBoundary(
  messages: JsonlMessage[],
): { startMessageId: string | null; endMessageId: string | null; startedAt: string; endedAt: string } {
  // Phase start = message after the previous episode's endMessageId, or
  // the first message if no prior episode exists.
  const idx = readEpisodeIndex(sessionDir!);
  const lastEnded = idx.entries[0]?.endMessageId ?? null; // newest first
  let startIdx = 0;
  if (lastEnded) {
    const found = messages.findIndex((m) => m.id === lastEnded);
    if (found >= 0) startIdx = found + 1;
  }
  if (startIdx >= messages.length) {
    // Nothing new since last episode → phase is empty.
    return {
      startMessageId: null,
      endMessageId: null,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    };
  }
  const phaseMessages = messages.slice(startIdx);
  const first = phaseMessages[0]!;
  const last = phaseMessages[phaseMessages.length - 1]!;
  return {
    startMessageId: first.id ?? null,
    endMessageId: last.id ?? null,
    startedAt: first.timestamp ? new Date(first.timestamp).toISOString() : new Date().toISOString(),
    endedAt: last.timestamp ? new Date(last.timestamp).toISOString() : new Date().toISOString(),
  };
}

// ============================================================================
// Artifact extraction (heuristic)
// ============================================================================

function extractArtifacts(messages: JsonlMessage[]): EpisodeArtifact[] {
  return extractArtifactsFromMessages(messages);
}

// ============================================================================
// Deterministic summary (LLM in follow-up commit)
// ============================================================================

function buildDeterministicSummary(
  decisions: ObservationSignal[],
  questions: ObservationSignal[],
  artifacts: EpisodeArtifact[],
  closeReason: EpisodeCloseReason,
): string {
  const parts: string[] = [];
  parts.push(`Phase closed via ${closeReason}.`);
  if (decisions.length > 0) {
    const top = decisions.slice(0, 3).map((d) => d.summary.replace(/\s+/g, ' ').slice(0, 120));
    parts.push(`Decisions: ${top.join(' | ')}`);
  }
  if (questions.length > 0) {
    parts.push(`${questions.length} open question${questions.length === 1 ? '' : 's'}.`);
  }
  if (artifacts.length > 0) {
    const fileCount = artifacts.filter((a) => a.type === 'file').length;
    const planCount = artifacts.filter((a) => a.type === 'plan').length;
    const bits: string[] = [];
    if (fileCount) bits.push(`${fileCount} file${fileCount === 1 ? '' : 's'}`);
    if (planCount) bits.push(`${planCount} plan${planCount === 1 ? '' : 's'}`);
    if (bits.length) parts.push(`Touched: ${bits.join(', ')}.`);
  }
  return parts.join(' ');
}

function inferOutcome(closeReason: EpisodeCloseReason, hasOpenQuestions: boolean): EpisodeOutcome {
  if (closeReason === 'session-done') return 'resolved';
  if (closeReason === 'anchor-change') return 'handoff';
  if (closeReason === 'idle-cutoff') return hasOpenQuestions ? 'blocked' : 'abandoned';
  return 'unknown';
}

// ============================================================================
// Main
// ============================================================================

function main(): void {
  const { header, messages } = readSession();
  const observations = readObservations();
  const phase = findPhaseBoundary(messages);
  if (!phase.startMessageId) {
    console.error('[episode] nothing to emit (no new messages since last episode)');
    process.exit(2);
  }

  // Filter observations to those whose messageRange intersects the current phase.
  // Best-effort — observations without messageRange are included only if they
  // were created during the phase window.
  const phaseObsIds = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (!m.id) continue;
    const found = messages.find((mm) => mm.id === phase.startMessageId);
    const startIdx = found ? messages.indexOf(found) : 0;
    if (i >= startIdx) phaseObsIds.add(m.id);
  }
  const phaseObs = observations.filter((o) => {
    const range = o.conversation?.messageRange;
    if (range?.from && phaseObsIds.has(range.from)) return true;
    if (range?.to && phaseObsIds.has(range.to)) return true;
    // Fallback: timestamp-based inclusion.
    return o.createdAt >= phase.startedAt && o.createdAt <= phase.endedAt;
  });

  const decisions = phaseObs.filter((o) => o.salience === 'pivotal');
  const questions = phaseObs.filter((o) => o.salience === 'question');
  const artifacts = extractArtifacts(messages.filter((m) => {
    // Restrict to phase messages.
    if (!m.id) return false;
    return phaseObsIds.has(m.id);
  }));

  const anchors: EpisodeAnchor[] = (header.anchors ?? []).map((a) => ({
    type: a.type,
    id: a.id,
    title: a.title,
  }));

  const summary = buildDeterministicSummary(decisions, questions, artifacts, closeReason);
  const outcome = inferOutcome(closeReason, questions.length > 0);

  // Track-B: invoke artifact extractor agent to produce the typed
  // Rahmen-subgraph. Best-effort — never blocks the episode write.
  const artifactGraph = runArtifactExtractor(phase.startMessageId!, phase.endMessageId!);

  const ep = writeEpisode(sessionDir!, {
    sessionId: header.id,
    workspaceId: header.workspaceId ?? null,
    closeReason,
    phase: { ...phase, anchors },
    summary,
    decisions: decisions.map((d) => d.id),
    openQuestions: questions.map((q) => q.id),
    artifactsTouched: artifacts,
    ...(artifactGraph ? { artifactGraph } : {}),
    outcome,
  });

  const graphSummary = artifactGraph
    ? `, graph=${artifactGraph.nodes.length}n/${artifactGraph.edges.length}e`
    : '';
  console.log(`[episode] wrote ${ep.id} (${decisions.length} decisions, ${questions.length} questions, ${artifacts.length} artifacts${graphSummary}, outcome=${outcome})`);
}

/**
 * Spawn orcha-extract-artifacts.ts synchronously (we are already in a
 * subprocess; no UI thread to block). Returns null on any failure so
 * the episode write still proceeds.
 *
 * Disable via ORCHA_EPISODE_DISABLE_GRAPH=1.
 */
function runArtifactExtractor(startMsgId: string, endMsgId: string): ArtifactGraph | null {
  if (process.env.ORCHA_EPISODE_DISABLE_GRAPH === '1') return null;
  const appRoot = process.env.CRAFT_APP_ROOT ?? process.cwd();
  const scriptPath = join(appRoot, 'scripts', 'orcha-extract-artifacts.ts');
  if (!existsSync(scriptPath)) return null;
  try {
    const res = spawnSync('npx', ['tsx', scriptPath, sessionDir!,
      '--start-msg', startMsgId, '--end-msg', endMsgId], {
      cwd: appRoot,
      env: process.env,
      encoding: 'utf-8',
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (res.status !== 0) {
      console.warn(`[episode] extractor exit ${res.status}: ${(res.stderr ?? '').slice(0, 200)}`);
      return null;
    }
    const out = (res.stdout ?? '').trim();
    if (!out) return null;
    const parsed = JSON.parse(out) as ArtifactGraph;
    if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
    return parsed;
  } catch (err) {
    console.warn('[episode] extractor failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

main();
