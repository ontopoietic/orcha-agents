/**
 * Fork (Orcha Agents): one-time app-isolation migration (2026-09).
 *
 * Orcha Agents and the original Craft Agents app are fully independent apps.
 * Until this migration, the fork still shared two pieces of state with the
 * original app via hardcoded `~/.craft-agent` paths:
 *   - credentials: `~/.craft-agent/credentials.enc`
 *   - messaging bindings: `~/.craft-agent/workspaces/{wsId}/messaging`
 * Both now live under CONFIG_DIR. On the first launch of a build containing
 * this change, the existing data is COPIED over once so nothing is lost.
 *
 * Invariants:
 *   - The legacy dir (`~/.craft-agent`) is a read-only source: nothing under it
 *     is created, modified, moved or deleted.
 *   - Runs once per CONFIG_DIR, guarded by a marker file
 *     `CONFIG_DIR/.migrations/isolation-2026-09.json`. If a step fails the
 *     marker is not written, so the (idempotent) migration retries next launch.
 *   - Skipped entirely when CONFIG_DIR IS the legacy dir (explicit
 *     CRAFT_CONFIG_DIR override pointing at ~/.craft-agent).
 *   - Credentials are copied byte-for-byte: the encryption key is derived from
 *     the machine id + a fixed tag + the salt stored in the file header — not
 *     from the file's directory — so the copy decrypts unchanged (see
 *     credentials/backends/secure-storage.ts). An existing (stale)
 *     `CONFIG_DIR/credentials.enc` is renamed to `credentials.enc.bak-<ts>` first.
 *   - Window state, logs and caches are not migrated (start fresh).
 *   - Never logs secrets — only paths, workspace ids and outcomes.
 */

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

import { CONFIG_DIR, getMessagingDir } from './paths.ts';

export const ISOLATION_MIGRATION_ID = 'isolation-2026-09';

/** Legacy (original Craft Agents app) data dir — migration SOURCE only. */
export function getLegacyCraftDir(): string {
  return join(homedir(), '.craft-agent');
}

export function getIsolationMarkerPath(configDir: string = CONFIG_DIR): string {
  return join(configDir, '.migrations', `${ISOLATION_MIGRATION_ID}.json`);
}

export interface IsolationMigrationResult {
  status: 'migrated' | 'already-done' | 'skipped-same-dir' | 'failed';
  credentials: 'copied' | 'no-source' | 'not-run';
  /** Absolute path of the backed-up pre-existing CONFIG_DIR/credentials.enc, if any */
  credentialsBackup?: string;
  /** Workspace ids whose messaging dir was copied */
  messagingCopied: string[];
  /** Workspace ids skipped because CONFIG_DIR already had a messaging dir */
  messagingSkippedExisting: string[];
  error?: string;
}

export interface IsolationMigrationOptions {
  configDir?: string;
  legacyDir?: string;
  log?: (message: string) => void;
  /** Injectable clock (tests) */
  now?: () => Date;
}

function readWorkspaceIds(configDir: string): string[] {
  const configPath = join(configDir, 'config.json');
  if (!existsSync(configPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as { workspaces?: Array<{ id?: unknown }> };
    return (parsed.workspaces ?? [])
      .map((w) => w?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  }
}

function timestampSuffix(date: Date): string {
  // 2026-09-27T18-30-00-123Z — filesystem-safe
  return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * Run the one-time isolation migration. Synchronous and exception-safe:
 * failures are logged and reported, never thrown (startup must not break).
 * Call early at startup, before the credential manager or messaging
 * bootstrap first touch their files.
 */
export function runIsolationMigration(options: IsolationMigrationOptions = {}): IsolationMigrationResult {
  const configDir = options.configDir ?? CONFIG_DIR;
  const legacyDir = options.legacyDir ?? getLegacyCraftDir();
  const log = options.log ?? ((m: string) => console.log(m));
  const now = options.now ?? (() => new Date());
  const prefix = `[${ISOLATION_MIGRATION_ID}]`;

  const result: IsolationMigrationResult = {
    status: 'migrated',
    credentials: 'not-run',
    messagingCopied: [],
    messagingSkippedExisting: [],
  };

  if (resolve(configDir) === resolve(legacyDir)) {
    result.status = 'skipped-same-dir';
    log(`${prefix} CONFIG_DIR is the legacy dir (${configDir}) — skipping`);
    return result;
  }

  const markerPath = getIsolationMarkerPath(configDir);
  if (existsSync(markerPath)) {
    result.status = 'already-done';
    return result;
  }

  try {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });

    // --- a. Credentials -------------------------------------------------
    const legacyCreds = join(legacyDir, 'credentials.enc');
    const targetCreds = join(configDir, 'credentials.enc');
    if (existsSync(legacyCreds)) {
      if (existsSync(targetCreds)) {
        const backup = `${targetCreds}.bak-${timestampSuffix(now())}`;
        renameSync(targetCreds, backup);
        result.credentialsBackup = backup;
        log(`${prefix} backed up existing ${targetCreds} -> ${backup}`);
      }
      copyFileSync(legacyCreds, targetCreds);
      chmodSync(targetCreds, 0o600);
      result.credentials = 'copied';
      log(`${prefix} copied credentials ${legacyCreds} -> ${targetCreds}`);
    } else {
      result.credentials = 'no-source';
      log(`${prefix} no legacy credentials at ${legacyCreds}`);
    }

    // --- b. Messaging bindings -------------------------------------------
    for (const wsId of readWorkspaceIds(configDir)) {
      const src = getMessagingDir(wsId, legacyDir);
      if (!existsSync(src)) continue;
      const dest = getMessagingDir(wsId, configDir);
      if (existsSync(dest)) {
        result.messagingSkippedExisting.push(wsId);
        log(`${prefix} messaging for workspace ${wsId}: target exists, not overwritten`);
        continue;
      }
      cpSync(src, dest, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
      result.messagingCopied.push(wsId);
      log(`${prefix} copied messaging bindings for workspace ${wsId} -> ${dest}`);
    }

    // --- Marker -----------------------------------------------------------
    mkdirSync(join(configDir, '.migrations'), { recursive: true });
    writeFileSync(
      markerPath,
      JSON.stringify(
        {
          id: ISOLATION_MIGRATION_ID,
          completedAt: now().toISOString(),
          legacyDir,
          credentials: result.credentials,
          credentialsBackup: result.credentialsBackup ?? null,
          messagingCopied: result.messagingCopied,
          messagingSkippedExisting: result.messagingSkippedExisting,
        },
        null,
        2,
      ),
      'utf-8',
    );
    log(
      `${prefix} done (credentials: ${result.credentials}, messaging copied: ${result.messagingCopied.length})`,
    );
    return result;
  } catch (error) {
    result.status = 'failed';
    result.error = error instanceof Error ? error.message : String(error);
    log(`${prefix} FAILED (will retry next launch): ${result.error}`);
    return result;
  }
}
