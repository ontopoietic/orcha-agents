/**
 * Fork (Orcha Agents): one-time app-isolation migration + path derivation.
 * All filesystem work happens in temp dirs; the real ~/.craft-agent and
 * ~/.orcha-agents are never touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { createHash } from 'crypto';

import { runIsolationMigration, getIsolationMarkerPath } from '../isolation-migration.ts';
import { getMessagingDir } from '../paths.ts';
import { SecureStorageBackend } from '../../credentials/backends/secure-storage.ts';

/** Snapshot of every entry under dir: relative path → mode/mtime/size/content hash */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      const rel = relative(dir, p);
      if (st.isDirectory()) {
        out[rel] = `dir:${st.mode}:${st.mtimeMs}`;
        walk(p);
      } else {
        const hash = createHash('sha256').update(readFileSync(p)).digest('hex');
        out[rel] = `file:${st.mode}:${st.mtimeMs}:${st.size}:${hash}`;
      }
    }
  };
  walk(dir);
  return out;
}

describe('runIsolationMigration', () => {
  let root: string;
  let legacyDir: string;
  let configDir: string;
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);
  const fixedNow = () => new Date('2026-09-27T12:00:00.000Z');

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orcha-isolation-'));
    legacyDir = join(root, '.craft-agent');
    configDir = join(root, '.orcha-agents');
    mkdirSync(legacyDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    logs.length = 0;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('copies legacy credentials readable via the new path (key derivation is dir-independent)', async () => {
    // Write credentials exactly as the OLD code did: backend rooted at the legacy dir.
    const oldBackend = new SecureStorageBackend({ dir: legacyDir });
    await oldBackend.set({ type: 'anthropic_api_key' } as any, { value: 'sk-test-123' } as any);
    expect(existsSync(join(legacyDir, 'credentials.enc'))).toBe(true);

    const res = runIsolationMigration({ configDir, legacyDir, log, now: fixedNow });
    expect(res.status).toBe('migrated');
    expect(res.credentials).toBe('copied');

    const target = join(configDir, 'credentials.enc');
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readFileSync(target).equals(readFileSync(join(legacyDir, 'credentials.enc')))).toBe(true);

    const newBackend = new SecureStorageBackend({ dir: configDir });
    const cred = await newBackend.get({ type: 'anthropic_api_key' } as any);
    expect(cred?.value).toBe('sk-test-123');

    // Logs never contain the secret
    expect(logs.join('\n')).not.toContain('sk-test-123');
  });

  it('backs up a stale existing CONFIG_DIR/credentials.enc before copying', () => {
    writeFileSync(join(legacyDir, 'credentials.enc'), 'LEGACY', { mode: 0o600 });
    writeFileSync(join(configDir, 'credentials.enc'), 'STALE', { mode: 0o600 });

    const res = runIsolationMigration({ configDir, legacyDir, log, now: fixedNow });
    expect(res.credentials).toBe('copied');
    expect(res.credentialsBackup).toBe(join(configDir, 'credentials.enc.bak-2026-09-27T12-00-00-000Z'));
    expect(readFileSync(res.credentialsBackup!, 'utf-8')).toBe('STALE');
    expect(readFileSync(join(configDir, 'credentials.enc'), 'utf-8')).toBe('LEGACY');
  });

  it('is idempotent: second run is a no-op (marker), does not clobber newer Orcha credentials', () => {
    writeFileSync(join(legacyDir, 'credentials.enc'), 'LEGACY', { mode: 0o600 });
    expect(runIsolationMigration({ configDir, legacyDir, log }).status).toBe('migrated');
    expect(existsSync(getIsolationMarkerPath(configDir))).toBe(true);

    // Orcha writes its own credentials after migration
    writeFileSync(join(configDir, 'credentials.enc'), 'ORCHA-NEW', { mode: 0o600 });
    const second = runIsolationMigration({ configDir, legacyDir, log });
    expect(second.status).toBe('already-done');
    expect(readFileSync(join(configDir, 'credentials.enc'), 'utf-8')).toBe('ORCHA-NEW');
    expect(readdirSync(configDir).filter((f) => f.includes('.bak-'))).toEqual([]);
  });

  it('handles missing legacy credentials and still writes the marker', () => {
    writeFileSync(join(configDir, 'credentials.enc'), 'ORCHA', { mode: 0o600 });
    const res = runIsolationMigration({ configDir, legacyDir, log });
    expect(res.status).toBe('migrated');
    expect(res.credentials).toBe('no-source');
    expect(readFileSync(join(configDir, 'credentials.enc'), 'utf-8')).toBe('ORCHA');
    expect(existsSync(getIsolationMarkerPath(configDir))).toBe(true);
  });

  it('copies messaging bindings only for Orcha workspaces without an existing target', () => {
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({ workspaces: [{ id: 'ws-a' }, { id: 'ws-b' }, { id: 'ws-c' }] }),
    );
    // ws-a: legacy bindings, no target → copied
    mkdirSync(getMessagingDir('ws-a', legacyDir), { recursive: true });
    writeFileSync(join(getMessagingDir('ws-a', legacyDir), 'bindings.json'), '{"a":1}');
    // ws-b: legacy + existing target → untouched
    mkdirSync(getMessagingDir('ws-b', legacyDir), { recursive: true });
    writeFileSync(join(getMessagingDir('ws-b', legacyDir), 'bindings.json'), '{"legacy":1}');
    mkdirSync(getMessagingDir('ws-b', configDir), { recursive: true });
    writeFileSync(join(getMessagingDir('ws-b', configDir), 'bindings.json'), '{"orcha":1}');
    // ws-other: in legacy but not an Orcha workspace → ignored
    mkdirSync(getMessagingDir('ws-other', legacyDir), { recursive: true });
    writeFileSync(join(getMessagingDir('ws-other', legacyDir), 'bindings.json'), '{}');

    const res = runIsolationMigration({ configDir, legacyDir, log });
    expect(res.messagingCopied).toEqual(['ws-a']);
    expect(res.messagingSkippedExisting).toEqual(['ws-b']);
    expect(readFileSync(join(getMessagingDir('ws-a', configDir), 'bindings.json'), 'utf-8')).toBe('{"a":1}');
    expect(readFileSync(join(getMessagingDir('ws-b', configDir), 'bindings.json'), 'utf-8')).toBe('{"orcha":1}');
    expect(existsSync(getMessagingDir('ws-other', configDir))).toBe(false);
  });

  it('never writes to the legacy dir', async () => {
    const oldBackend = new SecureStorageBackend({ dir: legacyDir });
    await oldBackend.set({ type: 'anthropic_api_key' } as any, { value: 'x' } as any);
    writeFileSync(join(legacyDir, 'config.json'), '{"workspaces":[]}');
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ workspaces: [{ id: 'ws-a' }] }));
    mkdirSync(getMessagingDir('ws-a', legacyDir), { recursive: true });
    writeFileSync(join(getMessagingDir('ws-a', legacyDir), 'bindings.json'), '{}');
    writeFileSync(join(configDir, 'credentials.enc'), 'STALE');

    const before = snapshot(legacyDir);
    runIsolationMigration({ configDir, legacyDir, log });
    runIsolationMigration({ configDir, legacyDir, log });
    expect(snapshot(legacyDir)).toEqual(before);
  });

  it('skips when CONFIG_DIR is the legacy dir', () => {
    writeFileSync(join(legacyDir, 'credentials.enc'), 'LEGACY');
    const res = runIsolationMigration({ configDir: legacyDir, legacyDir, log });
    expect(res.status).toBe('skipped-same-dir');
    expect(existsSync(join(legacyDir, '.migrations'))).toBe(false);
  });

  it('does not write the marker when a step fails, and retries next launch', () => {
    writeFileSync(join(legacyDir, 'credentials.enc'), 'LEGACY');
    // Block marker creation: `.migrations` is a file, not a dir
    writeFileSync(join(configDir, '.migrations'), 'blocker');
    const res = runIsolationMigration({ configDir, legacyDir, log });
    expect(res.status).toBe('failed');
    expect(existsSync(getIsolationMarkerPath(configDir))).toBe(false);

    rmSync(join(configDir, '.migrations'));
    const retry = runIsolationMigration({ configDir, legacyDir, log, now: fixedNow });
    expect(retry.status).toBe('migrated');
    expect(existsSync(getIsolationMarkerPath(configDir))).toBe(true);
    expect(readFileSync(join(configDir, 'credentials.enc'), 'utf-8')).toBe('LEGACY');
  });
});

describe('fork path derivation (fresh process, temp HOME)', () => {
  it('derives every runtime path from ~/.orcha-agents even if only ~/.craft-agent exists', () => {
    const home = mkdtempSync(join(tmpdir(), 'orcha-home-'));
    try {
      mkdirSync(join(home, '.craft-agent'), { recursive: true });
      writeFileSync(join(home, '.craft-agent', 'config.json'), '{"workspaces":[]}');
      const script = `
        const paths = await import(${JSON.stringify(join(import.meta.dir, '..', 'paths.ts'))});
        const ic = await import(${JSON.stringify(join(import.meta.dir, '..', '..', 'interceptor-common.ts'))});
        const perms = await import(${JSON.stringify(join(import.meta.dir, '..', '..', 'agent', 'permissions-config.ts'))});
        const { SecureStorageBackend } = await import(${JSON.stringify(join(import.meta.dir, '..', '..', 'credentials', 'backends', 'secure-storage.ts'))});
        const b = new SecureStorageBackend();
        await b.set({ type: 'anthropic_api_key' }, { value: 'v' });
        console.log(JSON.stringify({
          CONFIG_DIR: paths.CONFIG_DIR,
          messaging: paths.getMessagingDir('ws1'),
          icConfig: ic.CONFIG_FILE,
          icLogs: ic.LOG_DIR,
          perms: perms.getAppPermissionsDir(),
        }));
      `;
      const env = { ...process.env, HOME: home } as Record<string, string>;
      delete env.CRAFT_CONFIG_DIR;
      const proc = Bun.spawnSync([process.execPath, '-e', script], { env, cwd: tmpdir() });
      const stdout = proc.stdout.toString().trim().split('\n').pop()!;
      expect(proc.exitCode).toBe(0);
      const out = JSON.parse(stdout);
      const orcha = join(home, '.orcha-agents');
      expect(out.CONFIG_DIR).toBe(orcha);
      expect(out.messaging).toBe(join(orcha, 'workspaces', 'ws1', 'messaging'));
      expect(out.icConfig).toBe(join(orcha, 'config.json'));
      expect(out.icLogs).toBe(join(orcha, 'logs'));
      expect(out.perms).toBe(join(orcha, 'permissions'));
      expect(existsSync(join(orcha, 'credentials.enc'))).toBe(true);
      // The original app's dir gained nothing
      expect(readdirSync(join(home, '.craft-agent'))).toEqual(['config.json']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
