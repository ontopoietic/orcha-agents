/**
 * Orcha-specific Observer instruction: who is speaking.
 *
 * Passed alongside ORCHA_ANCHOR_INSTRUCTION in the `=== CUSTOM INSTRUCTIONS ===`
 * section. The vendored Mastra prompts assume every non-assistant turn is the
 * human; in Orcha ~11% of user-channel turns are machine-generated
 * (TaskRunner dispatch, background results, completion nudges) and were being
 * recorded as "User assigned / User provided …" observations. This is the
 * Orcha analogue of the upstream fix for Mastra #22195 (@mastra/memory 1.32.0),
 * which labels system signals by their tag instead of as the user.
 *
 * The titles referenced here are produced by `format-messages.ts`
 * (USER_ORIGIN_TITLES) — keep both in sync.
 */

export const ORCHA_SPEAKER_INSTRUCTION = `SPEAKERS — only messages titled "User" are written by the human user.

Some messages are machine-generated and must NEVER be attributed to the user:
- "Task Runner" — an automated orchestrator dispatching a task, a retry, or a
  verification request. The role, instructions and acceptance criteria it
  contains are the task's configuration, not the user's words or wishes.
- "Background Result" — output returned by a background agent/session the
  assistant launched earlier.
- "System Notification" — an automated status nudge (e.g. a background task
  finished).

HOW TO RECORD THEM:
- Never write "User asked / assigned / provided / wants …" for these messages.
  Name the real source instead: "Task Runner assigned the assistant as QA for
  Paket 15", "Background agent reported 3 failing tests".
- Instructions from a Task Runner are NOT user preferences or user decisions;
  do not mark them 🔴 as if the user stated them. Record the assignment and its
  concrete scope (task, repo, branch, criteria) as context.
- Results and outcomes inside these messages are still worth observing — just
  attribute them correctly.`;
