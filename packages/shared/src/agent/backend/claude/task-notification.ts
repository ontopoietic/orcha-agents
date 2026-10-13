const VALID_TASK_STATUSES = ['completed', 'failed', 'stopped'] as const;

export type ClaudeTaskStatus = typeof VALID_TASK_STATUSES[number];

export interface ClaudeTaskNotification {
  taskId: string;
  /** The tool call that started the task, when the SDK reports it. */
  toolUseId?: string;
  status: ClaudeTaskStatus;
  outputFile?: string;
  summary?: string;
}

export type ClaudeTaskNotificationClassification =
  | { kind: 'not-task-notification' }
  | { kind: 'missing-task-id' }
  | { kind: 'valid'; notification: ClaudeTaskNotification };

/**
 * Classify the SDK's unexported task_notification shape in one place so in-turn
 * adaptation and between-turn persistent-query routing cannot drift.
 */
export function classifyClaudeTaskNotification(
  message: unknown,
): ClaudeTaskNotificationClassification {
  const candidate = message as {
    type?: unknown;
    subtype?: unknown;
    task_id?: unknown;
    tool_use_id?: unknown;
    status?: unknown;
    output_file?: unknown;
    summary?: unknown;
  } | null | undefined;

  if (candidate?.type !== 'system' || candidate.subtype !== 'task_notification') {
    return { kind: 'not-task-notification' };
  }
  if (typeof candidate.task_id !== 'string' || candidate.task_id.length === 0) {
    return { kind: 'missing-task-id' };
  }

  const status = typeof candidate.status === 'string'
    && VALID_TASK_STATUSES.includes(candidate.status as ClaudeTaskStatus)
    ? (candidate.status as ClaudeTaskStatus)
    : 'completed';
  const outputFile = typeof candidate.output_file === 'string' && candidate.output_file
    ? candidate.output_file
    : undefined;
  const summary = typeof candidate.summary === 'string' && candidate.summary
    ? candidate.summary
    : undefined;

  return {
    kind: 'valid',
    notification: {
      taskId: candidate.task_id,
      ...(typeof candidate.tool_use_id === 'string' && candidate.tool_use_id ? { toolUseId: candidate.tool_use_id } : {}),
      status,
      ...(outputFile ? { outputFile } : {}),
      ...(summary ? { summary } : {}),
    },
  };
}

/** What a running task is doing, from the SDK's `task_progress` system message. */
export interface ClaudeTaskActivity {
  taskId: string;
  toolUseId?: string;
  /** One-line status: the agent's progress summary (`agentProgressSummaries`) or an MCP task's own status */
  summary?: string;
  lastToolName?: string;
  toolUses?: number;
}

/**
 * Read the SDK's unexported task_progress shape (in-turn adaptation and between-turn routing share
 * it, like classifyClaudeTaskNotification). Null for anything else.
 */
export function classifyClaudeTaskProgress(message: unknown): ClaudeTaskActivity | null {
  const candidate = message as {
    type?: unknown;
    subtype?: unknown;
    task_id?: unknown;
    tool_use_id?: unknown;
    summary?: unknown;
    last_tool_name?: unknown;
    usage?: { tool_uses?: unknown } | null;
  } | null | undefined;

  if (candidate?.type !== 'system' || candidate.subtype !== 'task_progress') return null;
  if (typeof candidate.task_id !== 'string' || candidate.task_id.length === 0) return null;
  const toolUses = candidate.usage?.tool_uses;
  return {
    taskId: candidate.task_id,
    ...(typeof candidate.tool_use_id === 'string' && candidate.tool_use_id ? { toolUseId: candidate.tool_use_id } : {}),
    ...(typeof candidate.summary === 'string' && candidate.summary.trim() ? { summary: candidate.summary.trim() } : {}),
    ...(typeof candidate.last_tool_name === 'string' && candidate.last_tool_name ? { lastToolName: candidate.last_tool_name } : {}),
    ...(typeof toolUses === 'number' && Number.isFinite(toolUses) ? { toolUses } : {}),
  };
}
