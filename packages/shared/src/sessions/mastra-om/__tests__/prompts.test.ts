import { describe, expect, it } from 'bun:test';
import {
  buildObserverPrompt,
  buildObserverSystemPrompt,
  buildObserverTaskPrompt,
  buildReflectorPrompt,
  buildReflectorSystemPrompt,
  COMPRESSION_GUIDANCE,
  MAX_COMPRESSION_LEVEL,
  OBSERVER_EXTRACTION_INSTRUCTIONS,
  OBSERVER_GUIDELINES,
  OBSERVER_SYSTEM_PROMPT,
} from '../index.ts';
import type { ObservableMessage } from '../../observation-watermark.ts';

describe('Observer system prompt', () => {
  it('carries Mastra-distinctive discipline lines verbatim', () => {
    expect(OBSERVER_SYSTEM_PROMPT).toContain('memory consciousness of an AI assistant');
    expect(OBSERVER_SYSTEM_PROMPT).toContain('USER ASSERTIONS ARE AUTHORITATIVE');
    expect(OBSERVER_SYSTEM_PROMPT).toContain('PRESERVE UNUSUAL PHRASING');
    expect(OBSERVER_SYSTEM_PROMPT).toContain('USE PRECISE ACTION VERBS');
    expect(OBSERVER_SYSTEM_PROMPT).toContain('TEMPORAL ANCHORING');
    expect(OBSERVER_SYSTEM_PROMPT).toContain('COMPLETION TRACKING');
    expect(OBSERVER_SYSTEM_PROMPT).toContain('<observations>');
    expect(OBSERVER_SYSTEM_PROMPT).toContain('<current-task>');
    expect(OBSERVER_SYSTEM_PROMPT).toContain('<suggested-response>');
    // Single-thread variant must explicitly forbid <thread> tags.
    expect(OBSERVER_SYSTEM_PROMPT).toContain('Do NOT add thread identifiers');
  });

  it('appends custom instructions when provided', () => {
    const sp = buildObserverSystemPrompt({ instruction: 'BE LACONIC' });
    expect(sp).toContain('=== CUSTOM INSTRUCTIONS ===');
    expect(sp).toContain('BE LACONIC');
  });

  it('extraction + guidelines blocks are present', () => {
    expect(OBSERVER_EXTRACTION_INSTRUCTIONS).toContain('DISTINGUISH USER ASSERTIONS FROM QUESTIONS');
    expect(OBSERVER_GUIDELINES).toContain('Add 1 to 5 observations per exchange');
  });
});

describe('Observer task prompt', () => {
  it('declares append-only contract when prior observations exist', () => {
    const task = buildObserverTaskPrompt('Date: Dec 4, 2025\n* 🔴 (14:30) hi');
    expect(task).toContain('## Previous Observations');
    expect(task).toContain('Do not repeat these existing observations');
    expect(task).toContain('appended to the existing observations');
  });

  it('omits prior-observations section when none given', () => {
    const task = buildObserverTaskPrompt(undefined);
    expect(task).not.toContain('## Previous Observations');
    expect(task).toContain('## Your Task');
  });

  it('passes prior continuation hints into the prompt', () => {
    const task = buildObserverTaskPrompt('* 🔴 hi', {
      priorCurrentTask: 'finishing the migration',
      priorSuggestedResponse: 'ask user about timezone',
    });
    expect(task).toContain('prior current-task: finishing the migration');
    expect(task).toContain('prior suggested-response: ask user about timezone');
  });

  it('skipContinuationHints adds the explicit NO-current-task instruction', () => {
    const task = buildObserverTaskPrompt(undefined, { skipContinuationHints: true });
    expect(task).toContain('Do NOT include <current-task>');
    expect(task).toContain('Only output <observations>');
  });
});

describe('buildObserverPrompt composes message history with task prompt', () => {
  const baseTs = Date.UTC(2025, 11, 4, 14, 30, 0);
  const messages: ObservableMessage[] = [
    { id: 'm1', content: 'I prefer terse answers', timestamp: baseTs, type: 'user' },
    { id: 'm2', content: 'Got it.', timestamp: baseTs + 60_000, type: 'assistant' },
  ];

  it('includes the New Message History header and the formatted dialogue', () => {
    const prompt = buildObserverPrompt(undefined, messages);
    expect(prompt).toContain('## New Message History to Observe');
    expect(prompt).toContain('User');
    expect(prompt).toContain('I prefer terse answers');
    expect(prompt).toContain('Assistant');
    expect(prompt).toContain('Got it.');
    expect(prompt).toContain('## Your Task');
  });
});

describe('Reflector', () => {
  it('system prompt contains the "memory consciousness" + reflector role + observer instructions block', () => {
    const sp = buildReflectorSystemPrompt();
    expect(sp).toContain('memory consciousness of an AI assistant');
    expect(sp).toContain('You are another part of the same psyche, the observation reflector.');
    expect(sp).toContain('<observational-memory-instruction>');
    expect(sp).toContain('your reflections are THE ENTIRETY of the assistants memory');
    expect(sp).toContain('USER ASSERTIONS vs QUESTIONS');
  });

  it('compression guidance covers all levels 0..MAX', () => {
    for (let i = 0; i <= MAX_COMPRESSION_LEVEL; i++) {
      expect(COMPRESSION_GUIDANCE).toHaveProperty(String(i));
    }
    expect(COMPRESSION_GUIDANCE[0]).toBe('');
    expect(COMPRESSION_GUIDANCE[1]).toContain('Aim for a 8/10 detail level');
    expect(COMPRESSION_GUIDANCE[2]).toContain('Aim for a 6/10 detail level');
    expect(COMPRESSION_GUIDANCE[3]).toContain('Aim for a 4/10 detail level');
    expect(COMPRESSION_GUIDANCE[4]).toContain('Aim for a 2/10 detail level');
  });

  it('buildReflectorPrompt embeds compression guidance at level > 0', () => {
    const level0 = buildReflectorPrompt('* 🔴 hi', undefined, 0);
    expect(level0).toContain('## OBSERVATIONS TO REFLECT ON');
    expect(level0).not.toContain('COMPRESSION REQUIRED');

    const level2 = buildReflectorPrompt('* 🔴 hi', undefined, 2);
    expect(level2).toContain('AGGRESSIVE COMPRESSION REQUIRED');

    const skip = buildReflectorPrompt('* 🔴 hi', undefined, 0, true);
    expect(skip).toContain('Do NOT include <current-task>');
  });

  it('manualPrompt is injected as ## SPECIFIC GUIDANCE', () => {
    const p = buildReflectorPrompt('* 🔴 hi', 'focus on architecture decisions');
    expect(p).toContain('## SPECIFIC GUIDANCE');
    expect(p).toContain('focus on architecture decisions');
  });

  it('boolean compressionLevel coerces to 0/1', () => {
    expect(buildReflectorPrompt('x', undefined, false)).not.toContain('COMPRESSION REQUIRED');
    expect(buildReflectorPrompt('x', undefined, true)).toContain('COMPRESSION REQUIRED');
  });
});
