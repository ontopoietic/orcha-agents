/**
 * LLM extractor — shared background-LLM helper for Orcha's detached side-jobs
 * (Observer, Reflector, and the auto-anchor pass).
 *
 * Extracted verbatim from scripts/orcha-reflect.ts so the same auth strategy
 * (OAuth → claude CLI, else Anthropic API key) and call shape are reused
 * instead of copied. Behaviour is byte-identical; the only generalisation is a
 * configurable log prefix and model-env precedence so each caller can label its
 * own warnings and pick its own default model.
 *
 * Auth resolution order:
 *   1. CLAUDE_CODE_OAUTH_TOKEN present + a resolvable claude binary → CLI mode
 *   2. <caller env keys> / ANTHROPIC_API_KEY → API mode
 *   3. otherwise null (caller decides how to degrade)
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type ExtractorMode =
  | { kind: 'cli'; cliPath: string; model: string }
  | { kind: 'api'; apiKey: string; model: string; endpoint: string; apiVersion: string };

export interface ResolveExtractorOptions {
  /** Default model when no model env var is set. */
  defaultModel?: string;
  /** Env var names checked (in order) for the model. */
  modelEnvKeys?: string[];
  /** Env var names checked (in order) for an API key. */
  apiKeyEnvKeys?: string[];
  /** Prefix for warning logs (e.g. "Reflector", "AutoAnchor"). */
  logPrefix?: string;
  /** CLI call timeout in ms (default 90s). */
  timeoutMs?: number;
}

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

function firstEnv(keys: string[] | undefined): string | undefined {
  for (const k of keys ?? []) {
    const v = process.env[k];
    if (v) return v;
  }
  return undefined;
}

export function resolveExtractor(opts: ResolveExtractorOptions = {}): ExtractorMode | null {
  const model =
    firstEnv(opts.modelEnvKeys ?? ['ORCHA_OBSERVER_MODEL']) ??
    opts.defaultModel ??
    'claude-sonnet-4-6';
  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauth) {
    const cliPath = process.env.ORCHA_OBSERVER_CLI_PATH ?? findClaudeBinary();
    if (cliPath) return { kind: 'cli', cliPath, model };
  }
  const apiKey =
    firstEnv(opts.apiKeyEnvKeys ?? ['ORCHA_OBSERVER_API_KEY']) ??
    process.env.ANTHROPIC_API_KEY;
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

interface AnthropicMessagesResponse {
  content?: Array<{ type: string; text?: string }>;
  error?: { message?: string };
}

/**
 * Environment for spawning the standalone `claude` CLI binary. In packaged
 * builds the orcha scripts themselves run via the Electron binary in Node
 * mode (ELECTRON_RUN_AS_NODE=1) — the CLI is a separate native binary that
 * must NOT inherit that flag, or it boots as a Node REPL instead of claude.
 */
export function buildCliSpawnEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

async function callClaudeCLI(
  cliPath: string,
  model: string,
  system: string,
  user: string,
  logPrefix: string,
  timeoutMs: number,
): Promise<string | null> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(
      cliPath,
      [
        '--print',
        '--model', model,
        '--append-system-prompt', system,
        '--disable-slash-commands',
        '--exclude-dynamic-system-prompt-sections',
        user,
      ],
      { env: buildCliSpawnEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      console.warn(`${logPrefix}: claude CLI timed out after ${Math.round(timeoutMs / 1000)}s`);
      resolve(null);
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim() || null);
      else {
        console.warn(`${logPrefix}: claude CLI exited ${code}: ${stderr.trim().slice(0, 300) || stdout.trim().slice(0, 300)}`);
        resolve(null);
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      console.warn(`${logPrefix}: claude CLI spawn error: ${err.message}`);
      resolve(null);
    });
  });
}

async function callAnthropicAPI(
  apiKey: string,
  model: string,
  endpoint: string,
  apiVersion: string,
  system: string,
  user: string,
  logPrefix: string,
  maxTokens: number,
  temperature: number,
): Promise<string | null> {
  const body = {
    model,
    max_tokens: maxTokens,
    temperature,
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
    console.warn(`${logPrefix}: Anthropic call failed (${res.status}): ${text.slice(0, 200)}`);
    return null;
  }
  const json = (await res.json()) as AnthropicMessagesResponse;
  if (json.error) {
    console.warn(`${logPrefix}: Anthropic error: ${json.error.message ?? 'unknown'}`);
    return null;
  }
  return (json.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .trim();
}

export async function callExtractor(
  mode: ExtractorMode,
  system: string,
  user: string,
  opts: { logPrefix?: string; timeoutMs?: number; maxTokens?: number; temperature?: number } = {},
): Promise<string | null> {
  const logPrefix = opts.logPrefix ?? 'Extractor';
  const timeoutMs = opts.timeoutMs ?? 90_000;
  if (mode.kind === 'cli') return callClaudeCLI(mode.cliPath, mode.model, system, user, logPrefix, timeoutMs);
  return callAnthropicAPI(
    mode.apiKey, mode.model, mode.endpoint, mode.apiVersion, system, user, logPrefix,
    opts.maxTokens ?? 8192,
    opts.temperature ?? 0.4,
  );
}
