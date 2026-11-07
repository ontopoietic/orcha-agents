import { describe, expect, it } from 'bun:test';
import { chooseSubagentModel, claudeModelFamily, type SubagentModelPicker } from '../core/subagent-model.ts';

const call = (extra: Record<string, unknown> = {}) => ({ description: 'Map the config loader', prompt: 'Find where config is loaded', ...extra });
const answers = (answer: Awaited<ReturnType<SubagentModelPicker>>): SubagentModelPicker => async () => answer;

describe('claudeModelFamily', () => {
  it('reads the family from Claude ids, including [1m] and dated variants', () => {
    expect(claudeModelFamily('claude-opus-5-5[1m]')).toBe('opus');
    expect(claudeModelFamily('claude-sonnet-5-5')).toBe('sonnet');
    expect(claudeModelFamily('claude-haiku-4-5-20251001')).toBe('haiku');
    expect(claudeModelFamily('claude-fable-5-1')).toBe('fable');
    expect(claudeModelFamily('gpt-6.1-sol')).toBeUndefined();
    expect(claudeModelFamily(undefined)).toBeUndefined();
  });
});

describe('chooseSubagentModel', () => {
  it('uses the Settings default when there is no decision', async () => {
    expect(await chooseSubagentModel(call(), 'claude-opus-5-5', { configured: 'sonnet' })).toBe('sonnet');
    expect(await chooseSubagentModel(call(), 'claude-opus-5-5', { configured: 'sonnet', picker: answers(null) })).toBe('sonnet');
    expect(await chooseSubagentModel(call(), 'claude-opus-5-5', {})).toBeUndefined();
  });

  it('prefers the decision model, and keeps the session model for a hard task', async () => {
    expect(await chooseSubagentModel(call(), 'claude-opus-5-5', { configured: 'sonnet', picker: answers('haiku') })).toBe('haiku');
    expect(await chooseSubagentModel(call(), 'claude-opus-5-5', { picker: answers('sonnet') })).toBe('sonnet');
    expect(await chooseSubagentModel(call(), 'claude-opus-5-5', { configured: 'haiku', picker: answers('session') })).toBeUndefined();
  });

  it('falls back to the Settings default when the decision fails', async () => {
    const failing: SubagentModelPicker = async () => { throw new Error('timeout'); };
    expect(await chooseSubagentModel(call(), 'claude-opus-5-5', { configured: 'sonnet', picker: failing })).toBe('sonnet');
  });

  it('never upgrades and never touches calls that name a model or fork', async () => {
    expect(await chooseSubagentModel(call(), 'claude-sonnet-5-5', { configured: 'sonnet' })).toBeUndefined();
    expect(await chooseSubagentModel(call(), 'claude-haiku-4-5', { configured: 'sonnet', picker: answers('sonnet') })).toBeUndefined();
    expect(await chooseSubagentModel(call({ model: 'opus' }), 'claude-opus-5-5', { configured: 'haiku' })).toBeUndefined();
    expect(await chooseSubagentModel(call({ subagent_type: 'fork' }), 'claude-opus-5-5', { configured: 'haiku' })).toBeUndefined();
    expect(await chooseSubagentModel(call(), 'gpt-6.1-sol', { configured: 'haiku' })).toBeUndefined();
  });

  it('only sets a model for built-in agents that inherit the session model', async () => {
    for (const subagent_type of ['general-purpose', 'Explore', 'Plan']) {
      expect(await chooseSubagentModel(call({ subagent_type }), 'claude-opus-5-5', { configured: 'sonnet' })).toBe('sonnet');
    }
    // Custom agents and pinned built-ins keep the model their definition chose; the decision model is not asked.
    let asked = false;
    const picker: SubagentModelPicker = async () => { asked = true; return 'haiku'; };
    for (const subagent_type of ['code-reviewer', 'statusline-setup', 'claude-code-guide']) {
      expect(await chooseSubagentModel(call({ subagent_type }), 'claude-opus-5-5', { configured: 'sonnet', picker })).toBeUndefined();
    }
    expect(asked).toBe(false);
  });

  it('passes the task to the picker', async () => {
    let seen: unknown;
    const picker: SubagentModelPicker = async (task) => { seen = task; return null; };
    await chooseSubagentModel(call({ subagent_type: 'Explore' }), 'claude-opus-5-5', { picker });
    expect(seen).toEqual({ prompt: 'Find where config is loaded', description: 'Map the config loader', subagentType: 'Explore' });
  });
});
