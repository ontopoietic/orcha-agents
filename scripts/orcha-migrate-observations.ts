#!/usr/bin/env npx tsx
/**
 * One-shot migrator — converts legacy `observations.json` into the canonical
 * Plan-A pair (`observations.md` + `observations-evidence.json`).
 *
 * Skips sessions where `observations.md` already exists unless `--force` is
 * passed. Use `--dry-run` to preview without writing.
 *
 * Usage:
 *   npx tsx scripts/orcha-migrate-observations.ts                # all workspaces
 *   npx tsx scripts/orcha-migrate-observations.ts <session-dir>  # single session
 *   npx tsx scripts/orcha-migrate-observations.ts --force --dry-run
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

interface LegacySignal {
  id?: string;
  createdAt?: string;
  summary?: string;
  salience?: 'pivotal' | 'question' | 'context';
  anchorRefs?: unknown[];
  conversation?: {
    messageRange?: { from?: string; to?: string };
    excerpt?: string;
    actor?: 'user' | 'agent';
  };
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

interface MigrationResult {
  sessionDir: string;
  signalCount: number;
  skipped: boolean;
  reason?: string;
}

function migrateSession(sessionDir: string, force: boolean, dryRun: boolean): MigrationResult {
  const jsonPath = join(sessionDir, 'data', 'observations.json');
  const mdPath = join(sessionDir, 'data', 'observations.md');
  const evidencePath = join(sessionDir, 'data', 'observations-evidence.json');

  if (!existsSync(jsonPath)) {
    return { sessionDir, signalCount: 0, skipped: true, reason: 'no observations.json' };
  }

  if (existsSync(mdPath) && !force) {
    return { sessionDir, signalCount: 0, skipped: true, reason: 'md exists (use --force)' };
  }

  let signals: LegacySignal[];
  try {
    const raw = readFileSync(jsonPath, 'utf-8');
    const parsed = JSON.parse(raw);
    signals = Array.isArray(parsed) ? parsed : parsed.signals ?? [];
  } catch (err) {
    return { sessionDir, signalCount: 0, skipped: true, reason: `parse error: ${(err as Error).message}` };
  }

  if (signals.length === 0) {
    return { sessionDir, signalCount: 0, skipped: true, reason: 'empty signals' };
  }

  // Group bullets by local date
  const byDate = new Map<string, string[]>();
  const evidence: Record<string, unknown> = {};

  for (const sig of signals) {
    const salience = sig.salience;
    let summary = sig.summary?.trim();
    const createdAt = sig.createdAt;
    if (!salience || !summary || !createdAt) continue;
    const emoji = SALIENCE_TO_EMOJI[salience];
    if (!emoji) continue;

    // Strip legacy double-prefixes from pre-Plan-A summaries:
    //   "🟡 USER ASKED: ...", "🟢 OBSERVED: ...", "🔴 USER STATED: ...",
    //   "🟢 AGENT NOTED: ..." — the bullet renderer adds the emoji itself.
    summary = summary.replace(
      /^[🔴🟡🟢]\s*(USER (STATED|ASKED)|OBSERVED|AGENT NOTED):\s*/u,
      '',
    ).trim();
    if (!summary) continue;

    const { date, time } = localDateAndTime(createdAt);
    const fromId = sig.conversation?.messageRange?.from ?? '';
    const toId = sig.conversation?.messageRange?.to ?? fromId;
    const shortId = fromId ? shortIdFromMsgId(fromId) : '';
    const anchorSuffix = shortId ? ` {${shortId}}` : '';
    const line = `- ${emoji} ${time} ${summary}${anchorSuffix}`;

    const list = byDate.get(date) ?? [];
    list.push(line);
    byDate.set(date, list);

    if (shortId && fromId) {
      evidence[shortId] = {
        fullMessageId: fromId,
        messageRangeTo: toId,
        excerpt: sig.conversation?.excerpt ?? '',
        actor: sig.conversation?.actor ?? 'user',
        createdAt,
        ...(Array.isArray(sig.anchorRefs) && sig.anchorRefs.length > 0
          ? { anchorRefs: sig.anchorRefs }
          : {}),
      };
    }
  }

  // Sort dates descending (newest first)
  const sortedDates = [...byDate.keys()].sort((a, b) => b.localeCompare(a));
  const out: string[] = [];
  for (const date of sortedDates) {
    out.push(`# ${date}`);
    for (const line of byDate.get(date) ?? []) out.push(line);
    out.push('');
  }
  const mdContent = out.join('\n').trimEnd() + '\n';

  if (dryRun) {
    return { sessionDir, signalCount: signals.length, skipped: false };
  }

  writeFileSync(mdPath, mdContent, 'utf-8');
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', 'utf-8');

  return { sessionDir, signalCount: signals.length, skipped: false };
}

function findSessionsRoot(): string[] {
  const roots: string[] = [];
  const orchaWorkspaces = join(homedir(), '.orcha-agents', 'workspaces');
  if (existsSync(orchaWorkspaces)) {
    for (const ws of readdirSync(orchaWorkspaces, { withFileTypes: true })) {
      if (!ws.isDirectory()) continue;
      const sessions = join(orchaWorkspaces, ws.name, 'sessions');
      if (existsSync(sessions)) roots.push(sessions);
    }
  }
  return roots;
}

function collectSessions(root: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    try {
      const stat = statSync(dir);
      if (stat.isDirectory()) result.push(dir);
    } catch { /* skip */ }
  }
  return result;
}

function main(): void {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const dryRun = args.includes('--dry-run');
  const explicitDir = args.find((a) => !a.startsWith('--'));

  const sessions: string[] = [];
  if (explicitDir) {
    sessions.push(explicitDir.replace(/^~/, homedir()));
  } else {
    for (const root of findSessionsRoot()) {
      sessions.push(...collectSessions(root));
    }
  }

  if (sessions.length === 0) {
    console.log('No sessions found.');
    return;
  }

  console.log(
    `Migrator: scanning ${sessions.length} session(s)` +
    `${force ? ' [--force]' : ''}${dryRun ? ' [--dry-run]' : ''}`
  );

  let migrated = 0;
  let skipped = 0;
  let totalSignals = 0;

  for (const dir of sessions) {
    const result = migrateSession(dir, force, dryRun);
    const name = dir.split('/').slice(-3).join('/');
    if (result.skipped) {
      skipped++;
      if (result.reason !== 'no observations.json') {
        console.log(`  skip   ${name}  (${result.reason})`);
      }
    } else {
      migrated++;
      totalSignals += result.signalCount;
      console.log(`  ${dryRun ? 'would ' : ''}write ${name}  (${result.signalCount} signals)`);
    }
  }

  console.log(
    `\nDone. ${migrated} ${dryRun ? 'would be ' : ''}migrated, ${skipped} skipped, ` +
    `${totalSignals} signals total.`
  );
}

main();
