#!/usr/bin/env npx tsx
/**
 * Streaming-Mode Probe — Phase 0 of Step 3 (Custom Message Provider).
 *
 * Goal: prove the SDK's Streaming Input Mode runs WITHOUT `resume`/`continue`,
 * and that the API only sees what we yield (no hidden history). Token usage
 * should match: system prompt + 1 user message.
 *
 * Run:
 *   npx tsx scripts/streaming-mode-probe.ts
 *
 * Auth: relies on whatever the SDK normally uses (OAuth login or
 * ANTHROPIC_API_KEY). No special setup beyond a working dev environment.
 */
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

const SYSTEM = 'You are a terse assistant. Reply in one short sentence.';
const USER_TEXT = 'Antworte mit einem deutschen Sprichwort über Geduld.';

async function* singleTurn(): AsyncIterable<SDKUserMessage> {
  yield {
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: USER_TEXT },
  };
}

async function main() {
  // Use a fresh tmp dir as cwd so the SDK has no prior session.jsonl to read.
  const probeCwd = mkdtempSync(join(tmpdir(), 'streaming-probe-'));
  console.log(`[probe] cwd=${probeCwd}`);

  const q = query({
    prompt: singleTurn(),
    options: {
      cwd: probeCwd,
      systemPrompt: SYSTEM,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      // No resume / continue / forkSession on purpose.
      stderr: (d: string) => process.stderr.write(`[sdk-stderr] ${d}`),
    },
  });

  let assistantText = '';
  let usage: unknown = null;
  let sawSystem = false;
  let messageCount = 0;
  for await (const m of q) {
    messageCount++;
    const t = (m as { type?: string }).type ?? 'unknown';
    if (t === 'system') sawSystem = true;
    if (t === 'assistant' && 'message' in m) {
      const msg = (m as { message: { content?: Array<{ type: string; text?: string }> } }).message;
      for (const block of msg.content ?? []) {
        if (block.type === 'text' && block.text) assistantText += block.text;
      }
    }
    if (t === 'result' && 'usage' in m) {
      usage = (m as { usage: unknown }).usage;
    }
  }

  console.log('---');
  console.log('[probe] messages received:', messageCount);
  console.log('[probe] saw system event:', sawSystem);
  console.log('[probe] assistant text:', assistantText.trim() || '<empty>');
  console.log('[probe] usage:', JSON.stringify(usage, null, 2));
  console.log('---');

  // Hand check: usage.input_tokens should reflect only system + 1 user message.
  // For Sonnet/Opus this is typically a few hundred tokens, not thousands.
  if (!assistantText.trim()) {
    console.error('[probe] FAIL: empty assistant response');
    process.exit(1);
  }
  console.log('[probe] OK — streaming mode without resume works');
}

main().catch((err) => {
  console.error('[probe] threw:', err);
  process.exit(1);
});
