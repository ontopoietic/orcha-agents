/**
 * PromptBuilder - System Prompt and Context Building
 *
 * Provides utilities for building system prompts and context blocks that both
 * ClaudeAgent and CodexAgent can use. Handles workspace capabilities, recovery
 * context, and user preferences formatting.
 *
 * Key responsibilities:
 * - Build workspace capabilities context
 * - Format recovery context for session resume failures
 * - Build session state context blocks
 * - Format user preferences for prompt injection
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isLocalMcpEnabled } from '../../workspaces/storage.ts';
import { formatPreferencesForPrompt } from '../../config/preferences.ts';
import { formatSessionState } from '../mode-manager.ts';
import { getDateTimeContext, getWorkingDirectoryContext } from '../../prompts/system.ts';
import { getSessionPlansPath, getSessionDataPath, getSessionPath } from '../../sessions/storage.ts';
import { maybeTriggerObserver } from '../../sessions/observation-trigger.ts';
import { maybeTriggerReflector } from '../../sessions/reflection-trigger.ts';
import { getRelevantEpisodes, renderRelevantEpisodesBlock } from '../../sessions/episode-retrieval.ts';
import { buildConversationTail, isStreamingModeEnabled } from './message-provider.ts';
import { createLogger } from '../../utils/debug.ts';
import type {
  PromptBuilderConfig,
  ContextBlockOptions,
  RecoveryMessage,
} from './types.ts';

const log = createLogger('prompt-builder');

/**
 * PromptBuilder provides utilities for building prompts and context blocks.
 *
 * Usage:
 * ```typescript
 * const promptBuilder = new PromptBuilder({
 *   workspace,
 *   session,
 *   debugMode: { enabled: true },
 * });
 *
 * // Build context blocks for a user message
 * const contextParts = promptBuilder.buildContextParts({
 *   permissionMode: 'explore',
 *   plansFolderPath: '/path/to/plans',
 * });
 * ```
 */
export class PromptBuilder {
  private config: PromptBuilderConfig;
  private workspaceRootPath: string;
  private pinnedPreferencesPrompt: string | null = null;

  constructor(config: PromptBuilderConfig) {
    this.config = config;
    this.workspaceRootPath = config.workspace?.rootPath ?? '';
  }

  // ============================================================
  // Context Building
  // ============================================================

  /**
   * Build all context parts for a user message.
   * Returns an array of strings that should be prepended to the user message.
   *
   * @param options - Context building options
   * @param sourceStateBlock - Pre-formatted source state (from SourceManager)
   * @returns Array of context strings
   */
  buildContextParts(
    options: ContextBlockOptions,
    sourceStateBlock?: string
  ): string[] {
    const parts: string[] = [];

    // Add date/time context first (enables prompt caching)
    parts.push(getDateTimeContext());

    // Add session state (permission mode, plans folder path, data folder path)
    const sessionId = this.config.session?.id ?? `temp-${Date.now()}`;
    const plansFolderPath = options.plansFolderPath ??
      getSessionPlansPath(this.workspaceRootPath, sessionId);
    const dataFolderPath = options.dataFolderPath ??
      getSessionDataPath(this.workspaceRootPath, sessionId);
    parts.push(formatSessionState(sessionId, {
      plansFolderPath,
      dataFolderPath,
      consumeModeChangeUserSignal: true,
    }));

    // Add source state if provided
    if (sourceStateBlock) {
      parts.push(sourceStateBlock);
    }

    // Add workspace capabilities
    parts.push(this.formatWorkspaceCapabilities());

    // Add working directory context
    const workingDirContext = this.getWorkingDirectoryContext();
    if (workingDirContext) {
      parts.push(workingDirContext);
    }

    // Add session observations (from observer) — also fires the
    // token-aware observer trigger as a side-effect, fire-and-forget.
    if (sessionId) {
      const sessionDir = getSessionPath(this.workspaceRootPath, sessionId);
      try {
        const decision = maybeTriggerObserver(sessionDir, sessionId);
        if (decision.triggered) {
          log.debug(`[buildContextParts] Observer triggered: ${decision.reason}`);
        }
      } catch (err) {
        log.debug('[buildContextParts] Observer trigger threw:', err);
      }

      // L2 Reflector — auto-fires when observations.json crosses 40k tokens.
      // Independent of Observer trigger (different threshold, different file).
      try {
        const reflectDecision = maybeTriggerReflector(sessionDir, sessionId);
        if (reflectDecision.triggered) {
          log.debug(`[buildContextParts] Reflector triggered: ${reflectDecision.reason}`);
        }
      } catch (err) {
        log.debug('[buildContextParts] Reflector trigger threw:', err);
      }

      const observationsBlock = this.getSessionObservations(sessionId);
      if (observationsBlock) {
        parts.push(observationsBlock);
      }

      // Episodic recall (L3) — surface past phases that share an anchor
      // with this session. Replaces manual handoff plans for anchor-scoped
      // continuation work. No-op when session has no anchors yet.
      try {
        const sessionAnchors = this.readSessionAnchors(sessionId);
        if (sessionAnchors.length > 0) {
          const hits = getRelevantEpisodes({
            workspaceRoot: this.workspaceRootPath,
            anchors: sessionAnchors,
            limit: 5,
          });
          const block = renderRelevantEpisodesBlock(hits);
          if (block) {
            log.debug(`[buildContextParts] ${hits.length} relevant episodes injected`);
            parts.push(block);
          }
        }
      } catch (err) {
        log.debug('[buildContextParts] Episode retrieval threw:', err);
      }

      // Streaming-mode: inject conversation tail. With ORCHA_STREAMING_MODE
      // active, the SDK no longer resume-loads prior history, so we feed
      // the last N messages here as a compact text block. No-op when off.
      if (isStreamingModeEnabled()) {
        try {
          const tail = buildConversationTail(sessionId, this.workspaceRootPath);
          if (tail) {
            log.debug(`[buildContextParts] Conversation tail injected (${tail.messageCount} msgs, ${tail.charCount}c)`);
            parts.push(tail.block);
          }
        } catch (err) {
          log.debug('[buildContextParts] Conversation tail threw:', err);
        }
      }
    }

    // Add anchor reminder if the session has no anchors
    if (sessionId) {
      const anchorReminder = this.getAnchorReminder(sessionId);
      if (anchorReminder) {
        parts.push(anchorReminder);
      }
    }

    return parts;
  }

  // ============================================================
  // Anchor Reminder (nudges the agent to set anchors when missing)
  // ============================================================

  /**
   * Build a reminder block when the session has no anchors. The agent then
   * knows to apply the `orcha-anchor-discipline` skill if a clear Orcha
   * artifact is referenced. Returns null if the session already has at least
   * one anchor or if anchors cannot be determined.
   */
  getAnchorReminder(sessionId: string): string | null {
    try {
      const sessionDir = getSessionPath(this.workspaceRootPath, sessionId);
      const jsonlPath = join(sessionDir, 'session.jsonl');
      if (!existsSync(jsonlPath)) return null;

      // Read just the header (first line) to check anchors.
      const raw = readFileSync(jsonlPath, 'utf-8');
      const firstNewline = raw.indexOf('\n');
      const firstLine = firstNewline > 0 ? raw.slice(0, firstNewline) : raw;
      const header = JSON.parse(firstLine) as { anchors?: unknown[] };

      const anchors = Array.isArray(header.anchors) ? header.anchors : [];
      if (anchors.length > 0) return null;

      return `<anchor_reminder>
This session has no anchors set. Anchors (Feature, Befund, Anliegen) scope the session to an Orcha artifact and let later memory aggregation group sessions correctly.

If the user has made the focus explicit, or it is unambiguous from context (e.g. "Lass uns am Modul-System weitermachen", or working on a feature visible via \`orcha feature list\`), apply the \`orcha-anchor-discipline\` skill and call \`set_session_anchors\` with the right anchor.

Do NOT guess. Wrong anchors are worse than no anchors. If the user is just exploring or the target is unclear, leave anchors empty — this reminder is a nudge, not a requirement.
</anchor_reminder>`;
    } catch {
      return null;
    }
  }

  /**
   * Format workspace capabilities for prompt injection.
   * Informs the agent about what features are available in this workspace.
   */
  formatWorkspaceCapabilities(): string {
    const capabilities: string[] = [];

    // Check local MCP server capability
    const localMcpEnabled = isLocalMcpEnabled(this.workspaceRootPath);
    if (localMcpEnabled) {
      capabilities.push('local-mcp: enabled (stdio subprocess servers supported)');
    } else {
      capabilities.push('local-mcp: disabled (only HTTP/SSE servers)');
    }

    return `<workspace_capabilities>\n${capabilities.join('\n')}\n</workspace_capabilities>`;
  }

  /**
   * Get working directory context for prompt injection.
   */
  getWorkingDirectoryContext(): string | null {
    const sessionId = this.config.session?.id;
    const effectiveWorkingDir = this.config.session?.workingDirectory ??
      (sessionId ? getSessionPath(this.workspaceRootPath, sessionId) : undefined);
    const isSessionRoot = !this.config.session?.workingDirectory && !!sessionId;

    return getWorkingDirectoryContext(
      effectiveWorkingDir,
      isSessionRoot,
      this.config.session?.sdkCwd
    );
  }

  // ============================================================
  // Session Observations (from Observer)
  // ============================================================

  /** Max characters for the observations block */
  private static readonly MAX_OBSERVATIONS_CHARS = 3000;
  /** Max observations to include */
  private static readonly MAX_OBSERVATIONS_COUNT = 50;
  /**
   * Don't inject observations until the conversation has at least this many
   * lines in session.jsonl (header counts). Below this threshold the raw
   * messages still fit in context — injection adds noise without value.
   * Override via env: ORCHA_OBSERVER_INJECT_MIN_LINES.
   */
  private static get MIN_LINES_BEFORE_INJECTION(): number {
    const fromEnv = process.env.ORCHA_OBSERVER_INJECT_MIN_LINES;
    if (fromEnv) {
      const n = parseInt(fromEnv, 10);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return 20; // ~10 user-turns rough proxy
  }

  /**
   * Count newlines in a file without loading it fully.
   * Returns 0 on error (caller should treat 0 as "below threshold").
   */
  private countJsonlLines(jsonlPath: string): number {
    try {
      const raw = readFileSync(jsonlPath, 'utf-8');
      // Trailing newline is fine — we only need a lower bound.
      let count = 0;
      for (let i = 0; i < raw.length; i++) {
        if (raw.charCodeAt(i) === 10) count++;
      }
      return count;
    } catch {
      return 0;
    }
  }

  /**
   * Strip anchor short-IDs (` {abcdef}` suffix) from the canonical Markdown
   * ledger before injecting into the system prompt. The main model doesn't
   * need them — the Sidecar (observations-evidence.json) is the source of
   * truth for UI back-links and echo-detection.
   *
   * Also caps total chars at MAX_OBSERVATIONS_CHARS — older date groups
   * drop off the bottom first (we keep newest-first ordering from the
   * Markdown file itself).
   */
  private formatMarkdownForInjection(md: string): { body: string; bulletCount: number } {
    const maxChars = PromptBuilder.MAX_OBSERVATIONS_CHARS;
    const stripped: string[] = [];
    let totalChars = 0;
    let bulletCount = 0;
    let truncated = false;
    for (const rawLine of md.split(/\r?\n/)) {
      if (truncated) break;
      // Strip trailing ` {anchor}` from bullet lines only; leave date headers alone.
      const line = rawLine.replace(/\s\{[a-z0-9]+\}\s*$/, '');
      if (line.startsWith('- ')) bulletCount++;
      if (totalChars + line.length + 1 > maxChars) {
        truncated = true;
        stripped.push('  ... (truncated)');
        break;
      }
      stripped.push(line);
      totalChars += line.length + 1;
    }
    return { body: stripped.join('\n').trimEnd(), bulletCount };
  }

  /**
   * Read the session's anchors from the JSONL header. Returns empty array
   * if the file does not exist or is malformed. Used by the anchor-filter
   * in `getSessionObservations`.
   */
  private readSessionAnchors(sessionId: string): Array<{ type: string; id: string }> {
    try {
      const sessionDir = getSessionPath(this.workspaceRootPath, sessionId);
      const jsonlPath = join(sessionDir, 'session.jsonl');
      if (!existsSync(jsonlPath)) return [];
      const raw = readFileSync(jsonlPath, 'utf-8');
      const firstNewline = raw.indexOf('\n');
      const firstLine = firstNewline > 0 ? raw.slice(0, firstNewline) : raw;
      const header = JSON.parse(firstLine) as { anchors?: unknown };
      if (!Array.isArray(header.anchors)) return [];
      return header.anchors
        .filter((a): a is { type: string; id: string } =>
          !!a && typeof a === 'object' &&
          typeof (a as Record<string, unknown>).type === 'string' &&
          typeof (a as Record<string, unknown>).id === 'string')
        .map((a) => ({ type: a.type, id: a.id }));
    } catch {
      return [];
    }
  }

  /**
   * Decide whether an observation belongs in this session's view.
   * Rules:
   * - If session has no anchors → show all observations (no filter)
   * - If session has anchors → show observations whose anchorRefs intersect,
   *   PLUS anchor-less observations (treated as session-local)
   */
  private observationMatchesSessionScope(
    obsAnchors: unknown,
    sessionAnchors: Array<{ type: string; id: string }>,
  ): boolean {
    if (sessionAnchors.length === 0) return true;
    if (!Array.isArray(obsAnchors) || obsAnchors.length === 0) return true;
    const sessionKeys = new Set(sessionAnchors.map((a) => `${a.type}:${a.id}`));
    for (const a of obsAnchors) {
      if (!a || typeof a !== 'object') continue;
      const r = a as Record<string, unknown>;
      if (typeof r.type === 'string' && typeof r.id === 'string') {
        if (sessionKeys.has(`${r.type}:${r.id}`)) return true;
      }
    }
    return false;
  }

  /**
   * Read observations from session data and format as a context block.
   * Returns null if no observations exist.
   *
   * The block persists across SDK compaction — the agent sees structured
   * memory of past conversation turns even after the original messages
   * are compacted away.
   *
   * Gated by:
   * - Conversation length (skip injection on short sessions where raw
   *   messages still fit cheaply)
   * - Anchor-scope: when session has anchors, only show observations
   *   whose anchors intersect (or are anchor-less)
   */
  getSessionObservations(sessionId: string): string | null {
    const sessionDir = getSessionPath(this.workspaceRootPath, sessionId);
    const markdownPath = join(sessionDir, 'data', 'observations.md');
    const observationsPath = join(sessionDir, 'data', 'observations.json');
    const jsonlPath = join(sessionDir, 'session.jsonl');

    const hasMarkdown = existsSync(markdownPath);
    const hasJson = existsSync(observationsPath);
    if (!hasMarkdown && !hasJson) return null;

    // Length gate — short conversations don't need observation injection
    const lineCount = this.countJsonlLines(jsonlPath);
    if (lineCount < PromptBuilder.MIN_LINES_BEFORE_INJECTION) {
      log.debug(`[getSessionObservations] Below length threshold (${lineCount} < ${PromptBuilder.MIN_LINES_BEFORE_INJECTION}), skipping injection`);
      return null;
    }

    // Primary path (post Plan A): canonical Markdown ledger. Anchors are
    // stripped before injection — the main model doesn't need them, the
    // sidecar carries the data the UI uses.
    if (hasMarkdown) {
      try {
        const md = readFileSync(markdownPath, 'utf-8');
        const stripped = this.formatMarkdownForInjection(md);
        if (!stripped.body) return null;
        const header = '<session_memory>';
        const footer = '</session_memory>';
        const intro = 'Structured observations from past conversation turns. These persist across compaction — the agent does NOT need to re-derive them.';
        const stats = `${stripped.bulletCount} observations`;
        log.debug(`[getSessionObservations] Injecting Markdown ledger (${stripped.bulletCount} bullets) for session ${sessionId}`);
        return `${header}\n${intro}\n\n${stripped.body}\n\n${stats}\n${footer}`;
      } catch (err) {
        log.debug('[getSessionObservations] Failed to read observations.md, falling back to JSON:', err);
        // fall through to JSON path
      }
    }

    if (!hasJson) return null;

    try {
      const raw = readFileSync(observationsPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const signals: Array<Record<string, unknown>> = parsed.signals ?? parsed;

      if (!Array.isArray(signals) || signals.length === 0) return null;

      // Anchor-scope filter
      const sessionAnchors = this.readSessionAnchors(sessionId);
      const scoped = signals.filter((s) =>
        this.observationMatchesSessionScope((s as Record<string, unknown>).anchorRefs, sessionAnchors)
      );
      if (scoped.length === 0) return null;

      // Sort: pivotal → question → context, then by recency within each group
      const salienceOrder: Record<string, number> = { pivotal: 0, question: 1, context: 2 };
      const sorted = [...scoped].sort((a, b) => {
        const sa = salienceOrder[(a as Record<string, unknown>).salience as string] ?? 3;
        const sb = salienceOrder[(b as Record<string, unknown>).salience as string] ?? 3;
        if (sa !== sb) return sa - sb;
        // Within same salience, newer first
        return ((b as Record<string, unknown>).createdAt as string ?? '').localeCompare(
          (a as Record<string, unknown>).createdAt as string ?? ''
        );
      });

      // Build lines, respecting max count and max chars
      const lines: string[] = [];
      let totalChars = 0;
      const maxChars = PromptBuilder.MAX_OBSERVATIONS_CHARS;
      const maxCount = PromptBuilder.MAX_OBSERVATIONS_COUNT;

      for (let i = 0; i < sorted.length && i < maxCount; i++) {
        const signal = sorted[i];
        const summary = (signal as Record<string, unknown>).summary as string;
        if (!summary) continue;

        const line = summary;
        if (totalChars + line.length + 1 > maxChars) break;

        lines.push(line);
        totalChars += line.length + 1;
      }

      if (lines.length === 0) return null;

      // Build the block
      const header = '<session_memory>';
      const footer = '</session_memory>';
      const intro = 'Structured observations from past conversation turns. These persist across compaction — the agent does NOT need to re-derive them.';
      const scopeNote = sessionAnchors.length > 0
        ? ` · scoped to ${sessionAnchors.length} anchor${sessionAnchors.length === 1 ? '' : 's'}`
        : '';
      const stats = `${signals.length} observations total, ${scoped.length} in scope, showing ${lines.length}${scopeNote}`;

      log.debug(`[getSessionObservations] Injecting ${lines.length} observations for session ${sessionId}`);

      return `${header}\n${intro}\n\n${lines.join('\n')}\n\n${stats}\n${footer}`;
    } catch (err) {
      log.debug('[getSessionObservations] Failed to read observations:', err);
      return null;
    }
  }

  // ============================================================
  // Recovery Context
  // ============================================================

  /**
   * Build recovery context from previous messages when SDK resume fails.
   * Called when we detect an empty response during resume.
   *
   * @param messages - Previous messages to include in recovery context
   * @returns Formatted recovery context string, or null if no messages
   */
  buildRecoveryContext(messages?: RecoveryMessage[]): string | null {
    if (!messages || messages.length === 0) {
      return null;
    }

    // Format messages as a conversation block
    const formattedMessages = messages.map((m) => {
      const role = m.type === 'user' ? 'User' : 'Assistant';
      // Truncate very long messages to avoid bloating context
      const content = m.content.length > 1000
        ? m.content.slice(0, 1000) + '...[truncated]'
        : m.content;
      return `[${role}]: ${content}`;
    }).join('\n\n');

    return `<conversation_recovery>
This session was interrupted and is being restored. Here is the recent conversation context:

${formattedMessages}

Please continue the conversation naturally from where we left off.
</conversation_recovery>

`;
  }

  // ============================================================
  // User Preferences
  // ============================================================

  /**
   * Format user preferences for prompt injection.
   * Preferences are pinned on first call to ensure consistency within a session.
   *
   * @param forceRefresh - Force refresh of cached preferences
   * @returns Formatted preferences string
   */
  formatPreferences(forceRefresh = false): string {
    // Return pinned preferences if available (ensures session consistency)
    if (this.pinnedPreferencesPrompt && !forceRefresh) {
      return this.pinnedPreferencesPrompt;
    }

    // Load and format preferences (function loads internally)
    this.pinnedPreferencesPrompt = formatPreferencesForPrompt();
    return this.pinnedPreferencesPrompt;
  }

  /**
   * Clear pinned preferences (called on session clear).
   */
  clearPinnedPreferences(): void {
    this.pinnedPreferencesPrompt = null;
  }

  // ============================================================
  // Configuration Accessors
  // ============================================================

  /**
   * Update the workspace configuration.
   */
  setWorkspace(workspace: PromptBuilderConfig['workspace']): void {
    this.config.workspace = workspace;
    this.workspaceRootPath = workspace?.rootPath ?? '';
  }

  /**
   * Update the session configuration.
   */
  setSession(session: PromptBuilderConfig['session']): void {
    this.config.session = session;
  }

  /**
   * Get the workspace root path.
   */
  getWorkspaceRootPath(): string {
    return this.workspaceRootPath;
  }

  /**
   * Check if debug mode is enabled.
   */
  isDebugMode(): boolean {
    return this.config.debugMode?.enabled ?? false;
  }

  /**
   * Get the system prompt preset.
   */
  getSystemPromptPreset(): string {
    return this.config.systemPromptPreset ?? 'default';
  }
}
