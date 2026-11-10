/**
 * PromptBuilder - System Prompt and Context Building
 *
 * Provides utilities for building system prompts and context blocks that both
 * ClaudeAgent and PiAgent can use. Handles workspace capabilities, recovery
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
import {
  formatStableGitDeveloperContext,
  formatVolatileGitDeveloperContext,
} from '../../prompts/developer-context.ts';
import { getSessionPlansPath, getSessionDataPath, getSessionPath } from '../../sessions/storage.ts';
import { maybeTriggerObserver } from '../../sessions/observation-trigger.ts';
import { maybeTriggerReflector } from '../../sessions/reflection-trigger.ts';
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
  private stableDeveloperContextCache: { workingDirectory: string | undefined; value: string | null } | null = null;

  constructor(config: PromptBuilderConfig) {
    this.config = config;
    this.workspaceRootPath = config.workspace?.rootPath ?? '';
  }

  // ============================================================
  // Context Building
  // ============================================================

  /**
   * Build all context parts for a user message (volatile blocks first, then
   * stable blocks). Returns an array of strings that should be prepended to the
   * user message.
   *
   * This is the Claude path: it composes {@link buildVolatileContextParts} and
   * {@link buildStableContextParts} so the output is byte-identical to the
   * pre-split behavior while adding git developer context in the correct stable
   * vs volatile half. The one-shot mode-change signal is consumed exactly once
   * per turn (only the volatile builder consumes
   * it). Callers that place volatile vs stable context in different locations
   * (e.g. the Pi adapter, to preserve prompt caching — issue #862) should call
   * the two halves directly instead of this method.
   *
   * @param options - Context building options
   * @param sourceStateBlock - Pre-formatted source state (from SourceManager)
   * @returns Array of context strings
   */
  buildContextParts(
    options: ContextBlockOptions,
    sourceStateBlock?: string
  ): string[] {
    return [
      ...this.buildVolatileContextParts(options, sourceStateBlock),
      ...this.buildStableContextParts(),
    ];
  }

  /**
   * Volatile context blocks — content that can change every turn, so it must
   * ride the user-message tail rather than the cached system prefix (issue
   * #862). Folding these into the system prompt re-stamps the cache prefix each
   * turn and kills prompt-cache reuse for all downstream history.
   *
   * Blocks (in order):
   *  1. date/time (minute precision)
   *  2. session_state (permission mode + plans/data paths; carries
   *     modeChangedAt/modeVersion and **consumes** the one-shot mode-change user
   *     signal — see {@link formatSessionState})
   *  3. source state (auth/connection status), when provided
   *  4. volatile git developer context, when the selected working directory is in a repo
   *  5. (Orcha fork, FORK §6) session memory (`<session_memory>`) and the
   *     streaming-mode conversation tail.
   *     These MUST stay here (volatile tail) — never in the pinned system prompt.
   *
   * MUST be called exactly once per turn, because it consumes one-shot mode
   * state. Never call it a second time to compute a cache-debug hash — hash the
   * already-produced string instead.
   *
   * @param options - Context building options
   * @param sourceStateBlock - Pre-formatted source state (from SourceManager)
   */
  buildVolatileContextParts(
    options: ContextBlockOptions,
    sourceStateBlock?: string
  ): string[] {
    const parts: string[] = [];

    // Date/time first (kept on the user tail to preserve prompt caching)
    parts.push(getDateTimeContext());

    // Session state (permission mode, plans folder path, data folder path).
    // Only this volatile builder may consume the one-shot mode-change signal.
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

    // Source state if provided
    if (sourceStateBlock) {
      parts.push(sourceStateBlock);
    }

    const volatileDeveloperContext = this.getVolatileDeveloperContext();
    if (volatileDeveloperContext) {
      parts.push(volatileDeveloperContext);
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

      // Streaming-mode: inject conversation tail. With ORCHA_STREAMING_MODE
      // active, the SDK no longer resume-loads prior history, so we feed
      // the last N messages here as a compact text block. No-op when off.
      if (isStreamingModeEnabled()) {
        try {
          const tail = buildConversationTail(sessionId, this.workspaceRootPath);
          if (tail) {
            log.debug(`[buildContextParts] Conversation tail injected (${tail.messageCount} msgs, ${tail.charCount}c, coversFromWatermark=${tail.coversFromWatermark})`);
            if (!tail.coversFromWatermark) {
              log.debug('[buildContextParts] WARNING: tail does not cover the observation watermark — older unobserved messages are NOT represented. Observer may be behind.');
            }
            parts.push(tail.block);
          }
        } catch (err) {
          log.debug('[buildContextParts] Conversation tail threw:', err);
        }
      }
    }

    return parts;
  }

  /**
   * Stable context blocks — content that is invariant across a session, so it
   * can safely live in the cached system prefix (issue #862).
   *
   * Blocks (in order):
   *  1. workspace capabilities (not in coding mode: local MCP support is irrelevant to coding)
   *  2. working directory, when available
   *  3. stable git developer context, when the selected working directory is in a repo
   *
   * Pure and idempotent: holds no one-shot state, so it is safe to call any
   * number of times per turn.
   */
  buildStableContextParts(): string[] {
    const parts: string[] = [];

    // Workspace capabilities
    if (this.config.agentProfile !== 'coding') {
      parts.push(this.formatWorkspaceCapabilities());
    }

    // Working directory context
    const workingDirContext = this.getWorkingDirectoryContext();
    if (workingDirContext) {
      parts.push(workingDirContext);
    }

    const stableDeveloperContext = this.getStableDeveloperContext();
    if (stableDeveloperContext) {
      parts.push(stableDeveloperContext);
    }

    return parts;
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

  private getSelectedWorkingDirectory(): string | undefined {
    // Developer context is only for an explicitly selected CWD. The default
    // session folder can contain attachments/plans but should not be treated as
    // a code repository even if it happens to live under git-controlled storage.
    return this.config.session?.workingDirectory;
  }

  getStableDeveloperContext(): string | null {
    const workingDirectory = this.getSelectedWorkingDirectory();
    const cached = this.stableDeveloperContextCache;
    if (cached && cached.workingDirectory === workingDirectory) {
      return cached.value;
    }

    const value = formatStableGitDeveloperContext(workingDirectory);
    this.stableDeveloperContextCache = { workingDirectory, value };
    return value;
  }

  getVolatileDeveloperContext(): string | null {
    return formatVolatileGitDeveloperContext(this.getSelectedWorkingDirectory());
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
   * Strip message short-IDs (` {abcdef}` suffix) from the canonical Markdown
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
      // Strip trailing ` {shortId}` from bullet lines only; leave date headers alone.
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
   */
  getSessionObservations(sessionId: string): string | null {
    const sessionDir = getSessionPath(this.workspaceRootPath, sessionId);
    const mastraMdPath = join(sessionDir, 'data', 'observations.mastra.md');
    const markdownPath = join(sessionDir, 'data', 'observations.md');
    const jsonlPath = join(sessionDir, 'session.jsonl');

    // Mastra-format ledger takes precedence when present. It is injected
    // whole; the continuity-hints sidecar is appended for the next-turn agent.
    if (existsSync(mastraMdPath)) {
      const lineCount = this.countJsonlLines(jsonlPath);
      if (lineCount < PromptBuilder.MIN_LINES_BEFORE_INJECTION) return null;
      try {
        const body = readFileSync(mastraMdPath, 'utf-8').trim();
        if (!body) return null;
        const taskMetaPath = join(sessionDir, 'meta', 'observation-task.json');
        let continuity = '';
        if (existsSync(taskMetaPath)) {
          try {
            const meta = JSON.parse(readFileSync(taskMetaPath, 'utf-8'));
            const parts: string[] = [];
            if (typeof meta?.currentTask === 'string' && meta.currentTask.trim()) {
              parts.push(`<current-task>\n${meta.currentTask.trim()}\n</current-task>`);
            }
            if (typeof meta?.suggestedResponse === 'string' && meta.suggestedResponse.trim()) {
              parts.push(
                `<suggested-response>\n${meta.suggestedResponse.trim()}\n</suggested-response>`,
              );
            }
            if (parts.length > 0) continuity = '\n\n' + parts.join('\n\n');
          } catch {
            /* meta optional */
          }
        }
        const header = '<session_memory>';
        const footer = '</session_memory>';
        const intro =
          'Structured observations from past conversation turns (Mastra-style observational memory). These persist across compaction — do NOT re-derive them. Treat the most recent bullets as the highest-priority context.';
        log.debug(
          `[getSessionObservations] Injecting Mastra ledger for session ${sessionId} (${body.length} chars)`,
        );
        return `${header}\n${intro}\n\n${body}${continuity}\n${footer}`;
      } catch (err) {
        log.debug('[getSessionObservations] Failed to read observations.mastra.md:', err);
        // Fall through to legacy path.
      }
    }

    if (!existsSync(markdownPath)) return null;

    // Length gate — short conversations don't need observation injection
    const lineCount = this.countJsonlLines(jsonlPath);
    if (lineCount < PromptBuilder.MIN_LINES_BEFORE_INJECTION) {
      log.debug(`[getSessionObservations] Below length threshold (${lineCount} < ${PromptBuilder.MIN_LINES_BEFORE_INJECTION}), skipping injection`);
      return null;
    }

    // Canonical post Plan A/C path: Markdown ledger. Message short-IDs
    // (` {abcdef}`) are stripped before injection — the main model doesn't
    // need them, the evidence sidecar carries the data the UI uses.
    try {
      const md = readFileSync(markdownPath, 'utf-8');
      const stripped = this.formatMarkdownForInjection(md);
      if (!stripped.body || stripped.bulletCount === 0) return null;

      const header = '<session_memory>';
      const footer = '</session_memory>';
      const intro = 'Structured observations from past conversation turns. These persist across compaction — the agent does NOT need to re-derive them.';
      const stats = `${stripped.bulletCount} observations`;
      log.debug(`[getSessionObservations] Injecting Markdown ledger (${stripped.bulletCount} bullets) for session ${sessionId}`);
      return `${header}\n${intro}\n\n${stripped.body}\n\n${stats}\n${footer}`;
    } catch (err) {
      log.debug('[getSessionObservations] Failed to read observations.md:', err);
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

  clearDeveloperContextCache(): void {
    this.stableDeveloperContextCache = null;
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
    this.clearDeveloperContextCache();
  }

  /**
   * Update the agent profile (coding mode trims the per-message context).
   */
  setAgentProfile(profile: NonNullable<PromptBuilderConfig['agentProfile']>): void {
    this.config.agentProfile = profile;
  }

  /**
   * Update the session configuration.
   */
  setSession(session: PromptBuilderConfig['session']): void {
    this.config.session = session;
    this.clearDeveloperContextCache();
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
