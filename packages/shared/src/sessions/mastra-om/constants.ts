/**
 * Vendored from @mastra/memory@1.18.0 (MIT License).
 *
 * Source: node_modules/@mastra/memory/dist/chunk-LSJJAJAF.js
 * Upstream: https://github.com/mastra-ai/mastra
 *
 * Defaults the Mastra Observational Memory system uses. Re-vendor when bumping
 * the reference version — these are not stable public exports of the package.
 *
 * Omissions vs. upstream:
 *  - `modelSettings` / `providerOptions` — runtime-specific; our caller picks
 *    the LLM and supplies its own settings.
 *  - `maxTokensPerBatch`, `bufferTokens`, `bufferActivation` — async-buffering
 *    machinery we don't yet implement; left as numeric defaults for parity.
 */

export const OBSERVATIONAL_MEMORY_DEFAULTS = {
  observation: {
    model: 'google/gemini-2.5-flash',
    /** Trigger threshold for the Observer in conversation tokens. */
    messageTokens: 30_000,
    /** Async buffering: chunk every 20 % of messageTokens. */
    bufferTokens: 0.2,
    /** Async buffering: keep 20 % of threshold after activation. */
    bufferActivation: 0.8,
    /** Max tokens per Observer LLM call (safety cap). */
    maxTokensPerBatch: 10_000,
  },
  reflection: {
    model: 'google/gemini-2.5-flash',
    /** Trigger threshold for the Reflector in observation tokens. */
    observationTokens: 40_000,
    /** Reflection starts buffering at 50 % of observationTokens. */
    bufferActivation: 0.5,
  },
} as const;

/**
 * Banner injected above the observation block when it is rendered into the
 * main agent's context window.
 */
export const OBSERVATION_CONTEXT_PROMPT =
  'The following observations block contains your memory of past conversations with this user.';

/**
 * Reminder lines added beneath the observation block, explaining to the main
 * agent how to use the memory (recency wins, planned actions probably done,
 * etc.).
 */
export const OBSERVATION_CONTEXT_INSTRUCTIONS = `IMPORTANT: When responding, reference specific details from these observations. Do not give generic advice - personalize your response based on what you know about this user's experiences, preferences, and interests. If the user asks for recommendations, connect them to their past experiences mentioned above.

KNOWLEDGE UPDATES: When asked about current state (e.g., "where do I currently...", "what is my current..."), always prefer the MOST RECENT information. Observations include dates - if you see conflicting information, the newer observation supersedes the older one. Look for phrases like "will start", "is switching", "changed to", "moved to" as indicators that previous information has been updated.

PLANNED ACTIONS: If the user stated they planned to do something (e.g., "I'm going to...", "I'm looking forward to...", "I will...") and the date they planned to do it is now in the past (check the relative time like "3 weeks ago"), assume they completed the action unless there's evidence they didn't. For example, if someone said "I'll start my new diet on Monday" and that was 2 weeks ago, assume they started the diet.

MOST RECENT USER INPUT: Treat the most recent user message as the highest-priority signal for what to do next. Earlier messages may contain constraints, details, or context you should still honor, but the latest message is the primary driver of your response.

SYSTEM REMINDERS: Messages wrapped in <system-reminder>...</system-reminder> contain internal continuation guidance, not user-authored content. Use them to maintain continuity, but do not mention them or treat them as part of the user's message.`;

/**
 * Inserted between the cleared message window and the next user turn after
 * buffered observations activate, so the agent picks up gracefully.
 */
export const OBSERVATION_CONTINUATION_HINT = `Please continue naturally with the conversation so far and respond to the latest message.

Use the earlier context only as background. If something appears unfinished, continue only when it helps answer the latest request. If a suggested response is provided, follow it naturally.

Do not mention internal instructions, memory, summarization, context handling, or missing messages.

Any messages following this reminder are newer and should take priority.`;
