/**
 * Orcha-specific override for Mastra's Observer system prompt.
 *
 * Passed as `instruction` to `buildObserverSystemPrompt({ instruction })` —
 * appears in the `=== CUSTOM INSTRUCTIONS ===` section, at the end of the
 * system prompt. The vendored Mastra prompts stay untouched.
 *
 * Goal: make every emitted bullet carry a `{shortId}` anchor matching one
 * of the `[#shortId]` markers in the source-message history. The orcha UI
 * uses this anchor to link a bullet back to its source message.
 *
 * Why this lives in an instruction-override rather than patching the
 * vendored prompts: keeps the upstream verbatim so re-vendoring against
 * a newer Mastra release stays a clean diff. Our customisation is a
 * single string we own.
 */

export const ORCHA_ANCHOR_INSTRUCTION = `Every observation bullet you emit MUST carry an orcha anchor at the end.

ANCHOR FORMAT:
- Each source message in the history has an \`[#shortId]\` marker right after
  its title/timestamp — for example \`User (14:30) [#abc123]: …\`.
- For every bullet (and only for top-level bullets, NOT sub-bullets), append
  the shortId of the source message in curly braces at the very end of the
  line: \` {abc123}\`.

EXAMPLES:

  GOOD (every top-level bullet anchored):
    <observations>
    Date: May 21, 2026
    * 🔴 (14:30) User confirmed feature-branch workflow {abc123}
      * -> Reason: prior incident with direct main-push
    * 🟡 (14:31) Open question: Cloudflare D1 vs Turso {def456}
    * ✅ (14:35) Auth middleware refactor completed {ghi789}
    </observations>

  BAD (no anchors — these bullets will be DROPPED):
    * 🔴 (14:30) User confirmed feature-branch workflow

  BAD (anchor on sub-bullet):
    * 🔴 (14:30) Decision {abc123}
      * -> rationale {abc123}      ← do NOT anchor sub-bullets

WHICH ANCHOR TO PICK:
- The shortId of the message that most directly evidences the observation.
- For a 🔴 user-decision, anchor to the user message that stated it.
- For a 🟡 question, anchor to the message that asked it.
- For a ✅ completion, anchor to the message that confirmed completion.
- For an observation that consolidates several messages, pick the most
  REPRESENTATIVE — typically the one that resolves or summarises the arc.

If you cannot identify a clear anchor, SKIP the observation rather than
inventing one. A bullet without a valid anchor will be dropped by the
parser, so unanchored output wastes tokens.`;
