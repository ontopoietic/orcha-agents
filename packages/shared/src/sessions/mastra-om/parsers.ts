/**
 * Vendored from @mastra/memory@1.18.0 (MIT License).
 *
 * Source: node_modules/@mastra/memory/dist/chunk-LPMZNXSF.js
 *   - parseObserverOutput              (line ~3665)
 *   - parseMemorySectionXml            (line ~3683)
 *   - extractListItemsOnly             (line ~3711)
 *   - sanitizeObservationLines         (line ~3722)
 *   - detectDegenerateRepetition       (line ~3734)
 *   - extractCurrentTask               (line ~3769)
 *   - hasCurrentTaskSection            (line ~3757)
 *   - parseReflectorOutput             (line ~4420, without `reconcile…`)
 *   - parseReflectorSectionXml         (line ~4436)
 *   - extractReflectorListItems        (line ~4460)
 *   - stripEphemeralAnchorIds          (line ~2541)
 *   - stripObservationGroups           (line ~828)
 *   - safeSlice                        (line ~2549)
 *   - OBSERVATION_GROUP_PATTERN        (line ~765)
 *
 * Re-vendor when bumping the reference version. Logic kept byte-identical to
 * upstream so parsing semantics match Mastra exactly (including edge cases
 * like degenerate-repetition detection and ephemeral anchor stripping).
 *
 * Omissions vs. upstream:
 *  - `reconcileObservationGroupsFromReflection` — only relevant when retrieval
 *    mode is on (range-tracked observation groups). We strip them with
 *    `stripObservationGroups` instead.
 */

// ============================================================================
// Patterns
// ============================================================================

export const OBSERVATION_GROUP_PATTERN =
  /<observation-group\s([^>]*)>([\s\S]*?)<\/observation-group>/g;

// ============================================================================
// String utilities
// ============================================================================

/** Slice safely on a UTF-16 surrogate pair boundary. */
export function safeSlice(str: string, end: number): string {
  if (end <= 0) return '';
  if (end >= str.length) return str;
  const code = str.charCodeAt(end - 1);
  const safeEnd = code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
  return str.slice(0, safeEnd);
}

// ============================================================================
// Anchor / group stripping
// ============================================================================

/** Remove ephemeral `[O1]` / `[O1-N2]` anchors injected for retrieval mode. */
export function stripEphemeralAnchorIds(observations: string): string {
  if (!observations) return observations;
  return observations.replace(/(^|\n)([^\S\n]*)\[(O\d+(?:-N\d+)?)\][^\S\n]*/g, '$1$2');
}

/** Drop `<observation-group ...>...</observation-group>` wrappers entirely. */
export function stripObservationGroups(observations: string): string {
  if (!observations) return observations;
  return observations
    .replace(OBSERVATION_GROUP_PATTERN, (_match, _attributes, content) => content.trim())
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ============================================================================
// Sanitizers
// ============================================================================

const MAX_OBSERVATION_LINE_CHARS = 10_000;

/** Truncate individual observation lines that exceed the per-line char cap. */
export function sanitizeObservationLines(observations: string): string {
  if (!observations) return observations;
  const lines = observations.split('\n');
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && line.length > MAX_OBSERVATION_LINE_CHARS) {
      lines[i] = safeSlice(line, MAX_OBSERVATION_LINE_CHARS) + ' … [truncated]';
      changed = true;
    }
  }
  return changed ? lines.join('\n') : observations;
}

/**
 * Heuristic detector for LLM outputs that collapsed into a repeating loop
 * (common Reflector failure mode under high compression). Two signals:
 *   - >40 % of fixed-size windows are duplicates
 *   - a single line > 50_000 chars (typical for runaway output)
 */
export function detectDegenerateRepetition(text: string): boolean {
  if (!text || text.length < 2_000) return false;
  const windowSize = 200;
  const step = Math.max(1, Math.floor(text.length / 50));
  const seen = new Map<string, number>();
  let duplicateWindows = 0;
  let totalWindows = 0;
  for (let i = 0; i + windowSize <= text.length; i += step) {
    const window = text.slice(i, i + windowSize);
    totalWindows++;
    const count = (seen.get(window) ?? 0) + 1;
    seen.set(window, count);
    if (count > 1) duplicateWindows++;
  }
  if (totalWindows > 5 && duplicateWindows / totalWindows > 0.4) return true;
  for (const line of text.split('\n')) {
    if (line.length > 50_000) return true;
  }
  return false;
}

// ============================================================================
// Observer-output parser
// ============================================================================

export interface ParsedObserverOutput {
  /** Sanitized observation block (markdown bullets, no XML wrappers). */
  observations: string;
  /** Body of `<current-task>` if present. */
  currentTask?: string;
  /** Body of `<suggested-response>` if present. */
  suggestedContinuation?: string;
  /** Body of `<thread-title>` if present. */
  threadTitle?: string;
  /** Raw LLM output, retained for debugging. */
  rawOutput: string;
  /** True when the degenerate-loop detector fired. Observations will be ''. */
  degenerate?: boolean;
}

export function parseObserverOutput(output: string): ParsedObserverOutput {
  if (detectDegenerateRepetition(output)) {
    return { observations: '', rawOutput: output, degenerate: true };
  }
  const parsed = parseMemorySectionXml(output);
  const observations = sanitizeObservationLines(parsed.observations || '');
  return {
    observations,
    currentTask: parsed.currentTask || undefined,
    suggestedContinuation: parsed.suggestedResponse || undefined,
    threadTitle: parsed.threadTitle || undefined,
    rawOutput: output,
  };
}

interface MemorySectionXml {
  observations: string;
  currentTask: string;
  suggestedResponse: string;
  threadTitle: string;
}

function parseMemorySectionXml(content: string): MemorySectionXml {
  const result: MemorySectionXml = {
    observations: '',
    currentTask: '',
    suggestedResponse: '',
    threadTitle: '',
  };
  const observationsRegex =
    /^[ \t]*<observations>([\s\S]*?)^[ \t]*<\/observations>/gim;
  const observationsMatches = [...content.matchAll(observationsRegex)];
  if (observationsMatches.length > 0) {
    result.observations = observationsMatches
      .map((m) => m[1]?.trim() ?? '')
      .filter(Boolean)
      .join('\n');
  } else {
    result.observations = extractListItemsOnly(content);
  }
  const currentTaskMatch = content.match(
    /^[ \t]*<current-task>([\s\S]*?)^[ \t]*<\/current-task>/im,
  );
  if (currentTaskMatch?.[1]) result.currentTask = currentTaskMatch[1].trim();
  const suggestedResponseMatch = content.match(
    /^[ \t]*<suggested-response>([\s\S]*?)^[ \t]*<\/suggested-response>/im,
  );
  if (suggestedResponseMatch?.[1]) result.suggestedResponse = suggestedResponseMatch[1].trim();
  const threadTitleMatch = content.match(
    /^[ \t]*<thread-title>([\s\S]*?)<\/thread-title>/im,
  );
  if (threadTitleMatch?.[1]) result.threadTitle = threadTitleMatch[1].trim();
  return result;
}

/** Fallback when the LLM forgot the `<observations>` wrapper. */
function extractListItemsOnly(content: string): string {
  const lines = content.split('\n');
  const listLines: string[] = [];
  for (const line of lines) {
    if (/^\s*[-*]\s/.test(line) || /^\s*\d+\.\s/.test(line)) {
      listLines.push(line);
    }
  }
  return listLines.join('\n').trim();
}

// ============================================================================
// Convenience helpers around `<current-task>` (used by main agent injection)
// ============================================================================

export function hasCurrentTaskSection(observations: string): boolean {
  if (/<current-task>/i.test(observations)) return true;
  const patterns = [
    /\*\*Current Task:?\*\*/i,
    /^Current Task:/im,
    /\*\*Current Task\*\*:/i,
    /## Current Task/i,
  ];
  return patterns.some((p) => p.test(observations));
}

export function extractCurrentTask(observations: string): string | null {
  const openTag = '<current-task>';
  const closeTag = '</current-task>';
  const startIdx = observations.toLowerCase().indexOf(openTag);
  if (startIdx === -1) return null;
  const contentStart = startIdx + openTag.length;
  const endIdx = observations.toLowerCase().indexOf(closeTag, contentStart);
  if (endIdx === -1) return null;
  const content = observations.slice(contentStart, endIdx).trim();
  return content || null;
}

// ============================================================================
// Reflector-output parser
// ============================================================================

export interface ParsedReflectorOutput {
  observations: string;
  suggestedContinuation?: string;
  degenerate?: boolean;
}

export function parseReflectorOutput(output: string): ParsedReflectorOutput {
  if (detectDegenerateRepetition(output)) {
    return { observations: '', degenerate: true };
  }
  const parsed = parseReflectorSectionXml(output);
  const sanitized = sanitizeObservationLines(stripEphemeralAnchorIds(parsed.observations || ''));
  return {
    observations: sanitized,
    suggestedContinuation: parsed.suggestedResponse || undefined,
  };
}

interface ReflectorSectionXml {
  observations: string;
  currentTask: string;
  suggestedResponse: string;
}

function parseReflectorSectionXml(content: string): ReflectorSectionXml {
  const result: ReflectorSectionXml = { observations: '', currentTask: '', suggestedResponse: '' };
  const observationsRegex =
    /^[ \t]*<observations>([\s\S]*?)^[ \t]*<\/observations>/gim;
  const observationsMatches = [...content.matchAll(observationsRegex)];
  if (observationsMatches.length > 0) {
    result.observations = observationsMatches
      .map((m) => m[1]?.trim() ?? '')
      .filter(Boolean)
      .join('\n');
  } else {
    const listItems = extractReflectorListItems(content);
    result.observations = listItems || content.trim();
  }
  const currentTaskMatch = content.match(/<current-task>([\s\S]*?)<\/current-task>/i);
  if (currentTaskMatch?.[1]) result.currentTask = currentTaskMatch[1].trim();
  const suggestedResponseMatch = content.match(
    /<suggested-response>([\s\S]*?)<\/suggested-response>/i,
  );
  if (suggestedResponseMatch?.[1]) result.suggestedResponse = suggestedResponseMatch[1].trim();
  return result;
}

function extractReflectorListItems(content: string): string {
  const lines = content.split('\n');
  const listLines: string[] = [];
  for (const line of lines) {
    if (/^\s*[-*]\s/.test(line) || /^\s*\d+\.\s/.test(line)) {
      listLines.push(line);
    }
  }
  return listLines.join('\n').trim();
}
