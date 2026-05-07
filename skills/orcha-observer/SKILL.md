---
name: orcha-observer
description: |
  Observe the current session's conversation and extract structured signals
  into the Orcha ledger. Run before compaction or when the conversation has
  accumulated significant context that should be preserved.
icon: 👁
---

# Orcha Observer — Inline Observation Skill

You are observing a running conversation to extract structured signals before
they are lost to context compaction. Your observations are written to the
Orcha ledger as persistent, searchable memory.

## Core Rules (adapted from Mastra OM)

1. **Distinguish Assertions from Questions.** User assertions are facts that
   override previous state. Open questions are not facts — they're
   exploration.

2. **USER ASSERTIONS TAKE PRECEDENCE.** If the user states something
   definitively ("We use pnpm, not npm"), that overrides any previous
   assumption or agent conclusion.

3. **State Changes as Overwrites.** When a user corrects or updates a
   previous statement, record it as a single current-state entry, not
   append both versions.

4. **Precise Verbs over Nouns.** "User decided to use Cloudflare D1" is
   better than "Database discussion".

5. **Split Multiple Events.** Each distinct observation gets its own signal.
   Don't bundle "user wants X and Y and Z" into one entry.

## Salience Levels

Every observation gets one of three salience markers:

- **🔴 PIVOTAL** — User stated a definitive decision, correction, constraint,
  or requirement. Things that MUST be remembered. Example:
  "User stated: Always work on feature branches, never push to main"

- **🟡 QUESTION** — User asked an open question that hasn't been resolved.
  These may become pivotal once answered. Example:
  "User asked: Should we use Cloudflare D1 or Turso?"

- **🟢 CONTEXT** — Background information, events, or observations that
  provide context but aren't binding. Example:
  "Observed: Session working directory is ~/Developer/orcha"

## Extraction Process

1. **Read the watermark** — Find the session's meta directory and read
   `observation-watermark.json` to determine the last observed message.

2. **Read new messages** — Extract messages from `session.jsonl` since the
   watermark. If no watermark exists, process the last 50 messages.

3. **Extract observations** — For each meaningful message, determine:
   - Salience level (🔴/🟡/🟢)
   - Actor (user/agent)
   - Summary (concise, precise verb)
   - Whether it's a state change (overwrites previous observation)

4. **Write signals to ledger** — Use `orcha signal add` or directly edit
   `.orcha-ledger.json` in the session's working directory. Each signal:
   ```json
   {
     "source": "conversation",
     "summary": "🔴 USER STATED: Project uses pnpm, not npm",
     "salience": "pivotal",
     "anchorRefs": [...session anchors...],
     "conversation": {
       "sessionId": "...",
       "messageRange": {"from": "msg-...", "to": "msg-..."},
       "excerpt": "...",
       "actor": "user"
     }
   }
   ```

5. **Update the watermark** — Write the last processed message ID and
   timestamp to `observation-watermark.json`.

## What to Observe

**Observe:**
- User decisions and preferences
- User corrections to previous statements
- Technical constraints revealed during conversation
- Architecture decisions and rationale
- Open questions that need resolution
- Significant events (branch creation, merge, deployment)
- Agent's key findings or conclusions

**Skip:**
- Greetings and pleasantries
- Tool execution details (unless they reveal decisions)
- Error messages (unless they reveal constraints)
- Repetitive confirmations
- Mode switches ("switch to Execute mode")

## Output Format

After observing, report a summary:

```
Observation complete:
- 🔴 3 pivotal assertions
- 🟡 1 open question
- 🟢 5 context observations
- Total signals written: 9
- Watermark updated to: msg-...
```

## Anchor Attribution

If the session has anchors (check session metadata), ALL observations
MUST include those anchors in `anchorRefs`. This scopes the observations
to the relevant Orcha artifacts for later aggregation.
