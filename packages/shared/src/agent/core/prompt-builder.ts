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

    // Add session observations (from observer)
    if (sessionId) {
      const observationsBlock = this.getSessionObservations(sessionId);
      if (observationsBlock) {
        parts.push(observationsBlock);
      }
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

  // ============================================================
  // Session Observations (from Observer)
  // ============================================================

  /** Max characters for the observations block */
  private static readonly MAX_OBSERVATIONS_CHARS = 3000;
  /** Max observations to include */
  private static readonly MAX_OBSERVATIONS_COUNT = 50;

  /**
   * Read observations from session data and format as a context block.
   * Returns null if no observations exist.
   *
   * The block persists across SDK compaction — the agent sees structured
   * memory of past conversation turns even after the original messages
   * are compacted away.
   */
  getSessionObservations(sessionId: string): string | null {
    const sessionDir = getSessionPath(this.workspaceRootPath, sessionId);
    const observationsPath = join(sessionDir, 'data', 'observations.json');

    if (!existsSync(observationsPath)) return null;

    try {
      const raw = readFileSync(observationsPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const signals: Array<Record<string, unknown>> = parsed.signals ?? parsed;

      if (!Array.isArray(signals) || signals.length === 0) return null;

      // Sort: pivotal → question → context, then by recency within each group
      const salienceOrder: Record<string, number> = { pivotal: 0, question: 1, context: 2 };
      const sorted = [...signals].sort((a, b) => {
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
      const stats = `${signals.length} observations total, showing last ${lines.length}`;

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
