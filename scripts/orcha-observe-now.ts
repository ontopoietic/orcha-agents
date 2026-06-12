/**
 * orcha-observe-now.ts — manual, auth-resolving Observer runner.
 *
 * The in-app "run observer now" path (and the token-trigger) spawn
 * `npx tsx scripts/orcha-observe.ts`, which only works in dev. In packaged
 * builds the script + tsx are absent, so the Observer never runs and the
 * watermark freezes. This helper lets you run the Observer for any session
 * from a dev checkout, minting a fresh OAuth token from the stored
 * credentials (same machine-bound AES store the app uses).
 *
 * Usage:
 *   npx tsx scripts/orcha-observe-now.ts <sessionDir>
 *
 * <sessionDir> e.g. ~/.orcha-agents/workspaces/orcha/sessions/260607-agile-bluff
 *
 * Auth precedence mirrors the app's resolveObserverAuthEnv():
 *   1. CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY already in env → reuse
 *   2. First Anthropic OAuth connection in config → mint a fresh token
 */

import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { getLlmConnections } from '../packages/shared/src/config/storage.ts';
import { getValidClaudeOAuthToken } from '../packages/shared/src/auth/state.ts';

async function main(): Promise<void> {
  const rawDir = process.argv[2];
  if (!rawDir) {
    console.error('Usage: npx tsx scripts/orcha-observe-now.ts <sessionDir>');
    process.exit(2);
  }
  const sessionDir = resolve(rawDir.replace(/^~/, homedir()));
  if (!existsSync(join(sessionDir, 'session.jsonl'))) {
    console.error(`No session.jsonl under ${sessionDir}`);
    process.exit(2);
  }
  // workspaceRoot = <...>/workspaces/<ws>  (sessionDir is <ws>/sessions/<id>)
  const workspaceRoot = resolve(sessionDir, '..', '..');
  const appRoot = resolve(import.meta.dirname, '..');

  const authEnv: Record<string, string> = {};
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    authEnv.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    console.log('auth: reusing CLAUDE_CODE_OAUTH_TOKEN from env');
  } else if (process.env.ANTHROPIC_API_KEY) {
    authEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    console.log('auth: reusing ANTHROPIC_API_KEY from env');
  } else {
    const conns = getLlmConnections();
    const cand =
      conns.find(
        (c) =>
          c.providerType === 'anthropic' &&
          (c as unknown as Record<string, unknown>).authType === 'oauth',
      ) ?? conns.find((c) => c.providerType === 'anthropic');
    if (!cand) {
      console.error(
        `auth: no Anthropic connection in config among [${conns.map((c) => `${c.slug}:${c.providerType}`).join(', ')}]`,
      );
      process.exit(1);
    }
    console.log(`auth: minting OAuth token via connection ${cand.slug}`);
    const res = await getValidClaudeOAuthToken(cand.slug);
    if (!res.accessToken) {
      console.error('auth: getValidClaudeOAuthToken returned no token');
      process.exit(1);
    }
    authEnv.CLAUDE_CODE_OAUTH_TOKEN = res.accessToken;
    console.log(`auth: got OAuth token (length=${res.accessToken.length})`);
  }

  const scriptPath = join(appRoot, 'scripts', 'orcha-observe.ts');
  console.log(`Running observer for ${sessionDir} ...`);
  const child = spawn('npx', ['tsx', scriptPath, sessionDir], {
    cwd: appRoot,
    env: {
      ...process.env,
      ...authEnv,
      CRAFT_APP_ROOT: appRoot,
      CRAFT_WORKSPACE_ROOT: workspaceRoot,
    },
    stdio: 'inherit',
  });
  child.on('close', (code) => process.exit(code ?? 0));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
