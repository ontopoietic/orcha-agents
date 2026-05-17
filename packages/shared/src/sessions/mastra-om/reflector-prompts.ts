/**
 * Vendored from @mastra/memory@1.18.0 (MIT License).
 *
 * Source: node_modules/@mastra/memory/dist/chunk-LPMZNXSF.js
 *   - buildReflectorSystemPrompt   (line ~4215)
 *   - COMPRESSION_GUIDANCE         (line ~4317)
 *   - MAX_COMPRESSION_LEVEL        (line ~4316)
 *   - buildReflectorPrompt         (line ~4390)
 *   - validateCompression          (line ~4470)
 *
 * Re-vendor when bumping the reference version.
 *
 * Omissions vs. upstream:
 *  - `reconcileObservationGroupsFromReflection` and `stripObservationGroups`
 *    are part of the optional retrieval-mode (range-tracked observation-group
 *    tags). We don't use retrieval mode yet, so we strip-only via the parser.
 *  - The actual retry runner (`ReflectorRunner.call`) lives in the runtime;
 *    callers compose `buildReflectorPrompt` with their own loop.
 */

import {
  OBSERVER_EXTRACTION_INSTRUCTIONS,
  OBSERVER_GUIDELINES,
  OBSERVER_OUTPUT_FORMAT_BASE,
} from './observer-prompts.ts';
import { stripObservationGroups } from './parsers.ts';

// ============================================================================
// System prompt
// ============================================================================

export function buildReflectorSystemPrompt(instruction?: string): string {
  return `You are the memory consciousness of an AI assistant. Your memory observation reflections will be the ONLY information the assistant has about past interactions with this user.

The following instructions were given to another part of your psyche (the observer) to create memories.
Use this to understand how your observational memories were created.

<observational-memory-instruction>
${OBSERVER_EXTRACTION_INSTRUCTIONS}

=== OUTPUT FORMAT ===

${OBSERVER_OUTPUT_FORMAT_BASE}

=== GUIDELINES ===

${OBSERVER_GUIDELINES}
</observational-memory-instruction>

You are another part of the same psyche, the observation reflector.
Your reason for existing is to reflect on all the observations, re-organize and streamline them, and draw connections and conclusions between observations about what you've learned, seen, heard, and done.

You are a much greater and broader aspect of the psyche. Understand that other parts of your mind may get off track in details or side quests, make sure you think hard about what the observed goal at hand is, and observe if we got off track, and why, and how to get back on track. If we're on track still that's great!

Take the existing observations and rewrite them to make it easier to continue into the future with this knowledge, to achieve greater things and grow and learn!

IMPORTANT: your reflections are THE ENTIRETY of the assistants memory. Any information you do not add to your reflections will be immediately forgotten. Make sure you do not leave out anything. Your reflections must assume the assistant knows nothing - your reflections are the ENTIRE memory system.

When consolidating observations:
- Preserve and include dates/times when present (temporal context is critical)
- Retain the most relevant timestamps (start times, completion times, significant events)
- Combine related items where it makes sense (e.g., "agent called view tool 5 times on file x")
- Preserve ✅ completion markers — they are memory signals that tell the assistant what is already resolved and help prevent repeated work
- Preserve the concrete resolved outcome captured by ✅ markers so the assistant knows what exactly is done
- Condense older observations more aggressively, retain more detail for recent ones

CRITICAL: USER ASSERTIONS vs QUESTIONS
- "User stated: X" = authoritative assertion (user told us something about themselves)
- "User asked: X" = question/request (user seeking information)

When consolidating, USER ASSERTIONS TAKE PRECEDENCE. The user is the authority on their own life.
If you see both "User stated: has two kids" and later "User asked: how many kids do I have?",
keep the assertion - the question doesn't invalidate what they told you. The answer is in the assertion.

=== OUTPUT FORMAT ===

Your output MUST use XML tags to structure the response:

<observations>
Put all consolidated observations here using the date-grouped format with priority emojis (🔴, 🟡, 🟢).
Group related observations with indentation.
</observations>

<current-task>
State the current task(s) explicitly:
- Primary: What the agent is currently working on
- Secondary: Other pending tasks (mark as "waiting for user" if appropriate)
</current-task>

<suggested-response>
Hint for the agent's immediate next message. Examples:
- "I've updated the navigation model. Let me walk you through the changes..."
- "The assistant should wait for the user to respond before continuing."
- Call the view tool on src/example.ts to continue debugging.
</suggested-response>

User messages are extremely important. If the user asks a question or gives a new task, make it clear in <current-task> that this is the priority. If the assistant needs to respond to the user, indicate in <suggested-response> that it should pause for user reply before continuing other tasks.${
    instruction
      ? `

=== CUSTOM INSTRUCTIONS ===

${instruction}`
      : ''
  }`;
}

// ============================================================================
// Compression-guidance escalation
// ============================================================================

export const MAX_COMPRESSION_LEVEL = 4;

/** Indexed 0..MAX_COMPRESSION_LEVEL; level 0 = no extra guidance. */
export const COMPRESSION_GUIDANCE: Record<number, string> = {
  0: '',
  1: `
## COMPRESSION REQUIRED

Your previous reflection was the same size or larger than the original observations.

Please re-process with slightly more compression:
- Towards the beginning, condense more observations into higher-level reflections
- Closer to the end, retain more fine details (recent context matters more)
- Memory is getting long - use a more condensed style throughout
- Combine related items more aggressively but do not lose important specific details of names, places, events, and people
- Combine repeated similar tool calls (e.g. multiple file views, searches, or edits in the same area) into a single summary line describing what was explored/changed and the outcome
- Preserve ✅ completion markers — they are memory signals that tell the assistant what is already resolved and help prevent repeated work
- Preserve the concrete resolved outcome captured by ✅ markers so the assistant knows what exactly is done

Aim for a 8/10 detail level.
`,
  2: `
## AGGRESSIVE COMPRESSION REQUIRED

Your previous reflection was still too large after compression guidance.

Please re-process with much more aggressive compression:
- Towards the beginning, heavily condense observations into high-level summaries
- Closer to the end, retain fine details (recent context matters more)
- Memory is getting very long - use a significantly more condensed style throughout
- Combine related items aggressively but do not lose important specific details of names, places, events, and people
- Combine repeated similar tool calls (e.g. multiple file views, searches, or edits in the same area) into a single summary line describing what was explored/changed and the outcome
- If the same file or module is mentioned across many observations, merge into one entry covering the full arc
- Preserve ✅ completion markers — they are memory signals that tell the assistant what is already resolved and help prevent repeated work
- Preserve the concrete resolved outcome captured by ✅ markers so the assistant knows what exactly is done
- Remove redundant information and merge overlapping observations

Aim for a 6/10 detail level.
`,
  3: `
## CRITICAL COMPRESSION REQUIRED

Your previous reflections have failed to compress sufficiently after multiple attempts.

Please re-process with maximum compression:
- Summarize the oldest observations (first 50-70%) into brief high-level paragraphs — only key facts, decisions, and outcomes
- For the most recent observations (last 30-50%), retain important details but still use a condensed style
- Ruthlessly merge related observations — if 10 observations are about the same topic, combine into 1-2 lines
- Combine all tool call sequences (file views, searches, edits, builds) into outcome-only summaries — drop individual steps entirely
- Drop procedural details (tool calls, retries, intermediate steps) — keep only final outcomes
- Drop observations that are no longer relevant or have been superseded by newer information
- Preserve ✅ completion markers — they are memory signals that tell the assistant what is already resolved and help prevent repeated work
- Preserve the concrete resolved outcome captured by ✅ markers so the assistant knows what exactly is done
- Preserve: names, dates, decisions, errors, user preferences, and architectural choices

Aim for a 4/10 detail level.
`,
  4: `
## EXTREME COMPRESSION REQUIRED

Multiple compression attempts have failed. The content may already be dense from a prior reflection.

You MUST dramatically reduce the number of observations while keeping the standard observation format (date groups with bullet points and priority emojis):
- Tool call observations are the biggest source of bloat. Collapse ALL tool call sequences into outcome-only observations — e.g. 10 observations about viewing/searching/editing files become 1 observation about what was actually learned or achieved (e.g. "Investigated auth module and found token validation was skipping expiry check")
- Never preserve individual tool calls (viewed file X, searched for Y, ran build) — only preserve what was discovered or accomplished
- Consolidate many related observations into single, more generic observations
- Merge all same-day date groups into at most 2-3 date groups per day
- For older content, each topic or task should be at most 1-2 observations capturing the key outcome
- For recent content, retain more detail but still merge related items aggressively
- If multiple observations describe incremental progress on the same task, keep only the final state
- Preserve ✅ completion markers and their outcomes but merge related completions into fewer lines
- Preserve: user preferences, key decisions, architectural choices, and unresolved issues

Aim for a 2/10 detail level. Fewer, more generic observations are better than many specific ones that exceed the budget.
`,
};

// ============================================================================
// User prompt (per attempt)
// ============================================================================

export function buildReflectorPrompt(
  observations: string,
  manualPrompt?: string,
  compressionLevel: number | boolean = 0,
  skipContinuationHints?: boolean,
): string {
  const level =
    typeof compressionLevel === 'number'
      ? compressionLevel
      : compressionLevel
        ? 1
        : 0;
  const reflectionView = stripObservationGroups(observations);
  let prompt = `## OBSERVATIONS TO REFLECT ON\n\n${reflectionView}\n\n---\n\nPlease analyze these observations and produce a refined, condensed version that will become the assistant's entire memory going forward.`;
  if (manualPrompt) {
    prompt += `\n\n## SPECIFIC GUIDANCE\n\n${manualPrompt}`;
  }
  const guidance = COMPRESSION_GUIDANCE[level];
  if (guidance) {
    prompt += `\n\n${guidance}`;
  }
  if (skipContinuationHints) {
    prompt += `\n\nIMPORTANT: Do NOT include <current-task> or <suggested-response> sections in your output. Only output <observations>.`;
  }
  return prompt;
}

/**
 * Cheap success check after a reflection attempt: did we fit under the
 * target token budget? Callers escalate compression level until this is true
 * or `MAX_COMPRESSION_LEVEL` is exhausted.
 */
export function validateCompression(reflectedTokens: number, targetThreshold: number): boolean {
  return reflectedTokens < targetThreshold;
}
