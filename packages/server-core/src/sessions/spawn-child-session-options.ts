/**
 * ORCHA §bg-child-sessions — pure mapping from a `spawn_session` tool-call
 * request to the `CreateSessionOptions` used to create the child session.
 *
 * Extracted out of the `onSpawnSession` closure in `SessionManager.ts` so the
 * inheritance-default and parent-linking rules (bg-child-routing-03,
 * bg-child-routing-04) are unit-testable without instantiating the full
 * SessionManager.
 */
import type { CreateSessionOptions } from '@craft-agent/shared/protocol';
import type { PermissionMode, ThinkingLevel } from '@craft-agent/shared/agent';

export interface SpawnChildSessionRequest {
  name?: string;
  llmConnection?: string;
  model?: string;
  enabledSourceSlugs?: string[];
  permissionMode?: PermissionMode;
  thinkingLevel?: ThinkingLevel;
  labels?: string[];
  workingDirectory?: string;
  projectId?: string;
}

/** The subset of the parent `ManagedSession` state a spawned child inherits from. */
export interface SpawnParentSession {
  id: string;
  llmConnection?: string;
  model?: string;
  enabledSourceSlugs?: string[];
  permissionMode?: PermissionMode;
  thinkingLevel?: ThinkingLevel;
  labels?: string[];
  workingDirectory?: string;
  projectId?: string;
}

/**
 * Builds the `CreateSessionOptions` for a `spawn_session`-created child.
 * Omitted request fields inherit from the parent session (bg-child-routing-04).
 * The child always records the parent's id and is always marked to notify the
 * parent on completion (bg-child-routing-03) — every spawn_session child gets
 * this, not just background-subagent reroutes.
 */
export function buildSpawnedChildSessionOptions(
  request: SpawnChildSessionRequest,
  parent: SpawnParentSession,
): CreateSessionOptions {
  return {
    name: request.name,
    llmConnection: request.llmConnection ?? parent.llmConnection,
    model: request.model ?? parent.model,
    enabledSourceSlugs: request.enabledSourceSlugs ?? parent.enabledSourceSlugs,
    permissionMode: request.permissionMode ?? parent.permissionMode,
    thinkingLevel: request.thinkingLevel ?? parent.thinkingLevel,
    labels: request.labels ?? parent.labels,
    workingDirectory: request.workingDirectory ?? parent.workingDirectory,
    projectId: request.projectId ?? parent.projectId,
    parentSessionId: parent.id,
    notifyParentOnComplete: true,
  };
}
