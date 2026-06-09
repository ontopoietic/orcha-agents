/**
 * Episode artifact extractors — Track A (deterministic).
 *
 * Pulls flat-list artifacts from the messages of a closed phase:
 *   - file edits (Edit/Write/Read/NotebookEdit)
 *   - plan submissions (SubmitPlan MCP tool)
 *   - anchor mutations (set_session_anchors MCP tool)
 *   - explicit `orcha <type> <verb>` invocations from Bash tool calls
 *
 * Track B (LLM-driven typed Rahmen-subgraph for tradeoffs / options /
 * risks / etc.) lives in `scripts/orcha-extract-artifacts.ts` and is
 * stored on `Episode.artifactGraph`. Track A populates the cheaper
 * `Episode.artifactsTouched`.
 */

import type { EpisodeArtifact } from './episode.ts';

// ============================================================================
// Whitelists — drift markers when the orcha CLI surface evolves
// ============================================================================

/**
 * Canonical orcha CLI subcommand names (artifact types). Sourced from
 * `~/Developer/orcha/packages/cli/src/commands/*.ts`. Bump when adding.
 */
export const ORCHA_CLI_TYPES = new Set<string>([
  'anliegen', 'archetype', 'area', 'artefakt-relation', 'assumption',
  'axiom', 'befund', 'chance', 'check', 'comment', 'constraint',
  'decision', 'deviation-record', 'doc', 'feature', 'flow', 'hypothesis',
  'interface', 'issue', 'milestone', 'model', 'obligations', 'pattern',
  'policy', 'preference', 'project', 'purpose', 'resonance', 'risk',
  'signal', 'skill', 'stakeholder', 'task', 'tool', 'tradeoff',
  'tradeoff-relation', 'wert',
]);

/**
 * Mutating CLI verbs we treat as "artifact touched". Read-only verbs
 * (list, get) are intentionally excluded — they don't mark a mutation.
 */
export const ORCHA_CLI_VERBS = new Set<string>([
  'create', 'add', 'add-many', 'update', 'set', 'link', 'done', 'option',
]);

// ============================================================================
// Public entry point
// ============================================================================

export interface ExtractorJsonlMessage {
  id?: string;
  type?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
}

export function extractArtifactsFromMessages(messages: ExtractorJsonlMessage[]): EpisodeArtifact[] {
  const seen = new Set<string>();
  const out: EpisodeArtifact[] = [];

  function push(art: EpisodeArtifact, key: string): void {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(art);
  }

  for (const m of messages) {
    if (m.type !== 'tool') continue;
    const tool = m.toolName;
    const input = m.toolInput ?? {};

    if (tool === 'Edit' || tool === 'Write' || tool === 'Read' || tool === 'NotebookEdit') {
      const path = (input.file_path ?? input.notebook_path) as string | undefined;
      if (path) push({ type: 'file', ref: path }, `file:${path}`);
    }
    if (tool === 'mcp__session__SubmitPlan') {
      const path = input.planPath as string | undefined;
      if (path) push({ type: 'plan', ref: path }, `plan:${path}`);
    }
    if (tool === 'mcp__session__set_session_anchors') {
      for (const a of parseAnchorsInput(input.anchors)) {
        push(a, `anchor:${a.type}:${a.ref}`);
      }
    }
    if (tool === 'Bash') {
      const cmd = typeof input.command === 'string' ? input.command : '';
      for (const a of parseOrchaCliInvocations(cmd)) {
        push(a, `orcha:${a.label ?? a.ref}`);
      }
    }
  }
  return out;
}

// ============================================================================
// Parsers (exported for test access)
// ============================================================================

/**
 * Normalize the `anchors` field from set_session_anchors. The MCP tool
 * has historically accepted both an array and a JSON-string blob — we
 * tolerate both.
 */
export function parseAnchorsInput(raw: unknown): EpisodeArtifact[] {
  let arr: unknown[];
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw);
      arr = Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  } else {
    return [];
  }

  const out: EpisodeArtifact[] = [];
  for (const a of arr) {
    if (!a || typeof a !== 'object') continue;
    const o = a as Record<string, unknown>;
    const t = typeof o.type === 'string' ? o.type : null;
    const id = typeof o.id === 'string' ? o.id : null;
    const label = typeof o.label === 'string' ? o.label
      : typeof o.title === 'string' ? o.title : undefined;
    if (!t || !id) continue;
    const coarse: EpisodeArtifact['type'] =
      t === 'feature' ? 'feature'
      : t === 'befund' ? 'befund'
      : t === 'anliegen' ? 'anliegen'
      : 'other';
    out.push({ type: coarse, ref: id, ...(label ? { label } : {}) });
  }
  return out;
}

/**
 * Walk a Bash `command` string for `orcha <type> <verb> ...` invocations.
 * Multi-line and `;`-chained commands are split. Unknown types/verbs
 * are skipped silently. Same orcha invocation appearing twice is NOT
 * deduped here (caller does that).
 */
export function parseOrchaCliInvocations(command: string): EpisodeArtifact[] {
  const out: EpisodeArtifact[] = [];
  for (const line of command.split(/[\n;]+/)) {
    const trimmed = line.trim();
    // Allow a leading "cd ... && " prefix or env vars before `orcha`.
    const m = trimmed.match(/^(?:.*?\s+)?orcha\s+([a-z][a-z-]*)\s+([a-z-]+)\b(.*)$/);
    if (!m) continue;
    const type = m[1]!;
    const verb = m[2]!;
    if (!ORCHA_CLI_TYPES.has(type)) continue;
    if (!ORCHA_CLI_VERBS.has(verb)) continue;
    const rest = m[3] ?? '';
    const nameMatch =
      rest.match(/--name\s+(['"])([^'"]+)\1/) ?? rest.match(/--name\s+(\S+)/);
    const idMatch = rest.match(/^\s+([a-zA-Z0-9_-]{6,})/);
    const label = nameMatch?.[2] ?? nameMatch?.[1];
    const ref = idMatch?.[1];
    out.push({
      type: 'other',
      ref: ref ?? `${type}:${label ?? verb}`,
      label: label ? `${type}: ${label}` : `${type} (${verb})`,
    });
  }
  return out;
}
