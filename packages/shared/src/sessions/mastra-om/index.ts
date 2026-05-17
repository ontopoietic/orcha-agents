/**
 * Mastra Observational Memory primitives, vendored from @mastra/memory@1.18.0
 * under the MIT License. Re-export surface for use by orcha-agents'
 * observer / reflector runners.
 *
 * Why vendored instead of `pnpm add @mastra/memory`:
 *  - These functions are not part of the documented public API; upstream may
 *    rename/remove them without notice.
 *  - We don't want the Mastra runtime (`Memory`, `Agent`, storage adapters);
 *    only the prompts + parsers.
 *  - Vendoring makes the upgrade decision explicit instead of automatic.
 *
 * To re-vendor against a newer Mastra release:
 *  1. Bump the reference version in every file's header.
 *  2. Diff the upstream source against each file in this directory.
 *  3. Update prompt strings byte-for-byte; update parsers if XML schema
 *     changed.
 *  4. Add tests for any newly recognised output shape.
 */

export {
  OBSERVATIONAL_MEMORY_DEFAULTS,
  OBSERVATION_CONTEXT_PROMPT,
  OBSERVATION_CONTEXT_INSTRUCTIONS,
  OBSERVATION_CONTINUATION_HINT,
} from './constants.ts';

export {
  OBSERVER_EXTRACTION_INSTRUCTIONS,
  OBSERVER_GUIDELINES,
  OBSERVER_OUTPUT_FORMAT_BASE,
  OBSERVER_SYSTEM_PROMPT,
  buildObserverOutputFormat,
  buildObserverSystemPrompt,
  buildObserverTaskPrompt,
  buildObserverPrompt,
  type BuildObserverTaskPromptOptions,
} from './observer-prompts.ts';

export {
  MAX_COMPRESSION_LEVEL,
  COMPRESSION_GUIDANCE,
  buildReflectorSystemPrompt,
  buildReflectorPrompt,
  validateCompression,
} from './reflector-prompts.ts';

export {
  OBSERVATION_GROUP_PATTERN,
  safeSlice,
  stripEphemeralAnchorIds,
  stripObservationGroups,
  sanitizeObservationLines,
  detectDegenerateRepetition,
  parseObserverOutput,
  parseReflectorOutput,
  hasCurrentTaskSection,
  extractCurrentTask,
  type ParsedObserverOutput,
  type ParsedReflectorOutput,
} from './parsers.ts';

export { formatMessagesForObserver } from './format-messages.ts';
