---
name: "Orcha Anchor Discipline"
description: "Set session anchors (Feature, Befund, Anliegen) when work has a clear Orcha-artifact target, so later observational-memory aggregation can group sessions by what they're about."
alwaysAllow: ["Bash"]
---

# Orcha Anchor Discipline

You are working in a session that may belong to one or more Orcha framework artifacts. Setting **anchors** explicitly groups this session under those artifacts in the UI and lets later memory aggregation (episodic summaries, observer/reflector) operate over the right scope.

## When to set an anchor

Set an anchor when **the user has made the focus explicit or it is unambiguous from context**:

- "Lass uns am Modul-System weitermachen" → feature anchor on Modul-System
- "Dieser Befund über Lifecycle-Schritte muss geklärt werden" → befund anchor
- "Pocock-Adoption sollten wir angehen" → anliegen anchor
- A working-directory + obvious task ("Implement feature X" with X visible in `orcha feature list`) → feature anchor

**Do not guess.** If the user is exploring, refactoring, debugging without a clear artifact target, leave anchors empty. Wrong anchors are worse than no anchors — they pollute later memory aggregation.

## How to set an anchor

1. **Discover candidate IDs** in the session's working directory:

   ```bash
   orcha feature list      # nested: areas[].features[]
   orcha befund list       # flat: [{id, title, category, status, ...}]
   orcha anliegen list     # flat: [{id, rawText, form, status, ...}]
   ```

   The CLI is at `~/Developer/orcha/packages/cli/bin/orcha.sh` if not on PATH. Output is JSON by default; pass `--human` for readable form.

2. **Match user intent to ID** — confirm the title matches what the user is asking about. If multiple candidates fit, ask before guessing.

3. **Call `set_session_anchors`**:

   ```
   set_session_anchors({
     anchors: [
       { type: "feature", id: "feat-uuid-here", title: "Modul-System v1" }
     ]
   })
   ```

   - `type`: one of `feature` | `befund` | `anliegen`
   - `id`: UUID from the CLI listing (NOT the slug or name)
   - `title`: snapshot of the artifact title — recommended, shown in the UI chip

   Multiple anchors are allowed (e.g. session covers both a feature and a related befund). The call **replaces** the full anchor list — pass an empty array to clear.

## When NOT to set an anchor

- User says "I'm just exploring" / "Just a quick test" / "Help me debug X"
- Working directory has no Orcha database (CLI returns empty or errors)
- Task spans many features without a clear primary one — pick zero, not "all of them"
- Uncertainty about which artifact matches — ask the user instead of guessing

## Removing an anchor

If the focus shifts, remove a stale anchor by calling `set_session_anchors` again with the new (smaller) list. The full list is replaced on every call.

## Why this matters

Anchors are the **scope key** for later observational-memory aggregation: episodic summaries, observer/reflector compression, and cross-session feature reviews all key off them. A correctly anchored session tells the system "this conversation is about Modul-System v1"; an incorrectly anchored one corrupts that signal.

When in doubt: ask the user, or leave the session unanchored. Honesty beats coverage.
