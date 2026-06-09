# Observation Format Specification

Canonical format for observations written by the Observer agent and read by
the prompt-builder (`<session_memory>` block), the Reflector, and the UI.

Inspired by Mastra Observational Memory, validated by spike-report
`sessions/260511-swift-otter/data/spike-report.md` (~70 % token reduction
vs. JSON, quality parity).

## Storage layout

Per session, under `data/`:

- `observations.md` — human- and LLM-readable Markdown bullets. THIS file is
  injected into the main model's context.
- `observations-evidence.json` — sidecar with verbatim excerpts, full message
  IDs, anchor refs, actor, timestamps. Keyed by short anchor ID. Read ONLY by
  UI and echo-detection — never injected into the main model.
- `observations.json` (legacy) — old JSON format. Read-only fallback for
  sessions created before the format switch.

## Markdown format

```
# 2026-05-11
- 🔴 17:38 User reported 240k-token session without observer trigger {abc123}
  - SDK string-mode resumes full jsonl every turn — observer only adds context
- 🟡 17:43 Open question: how does streaming mode work? {def456}
- 🟢 17:50 Spike measured 69 % token saving vs JSON {ghi789}

# 2026-05-09
- 🔴 14:49 User chose Rahmen-Graph as next work item {u5luxw}
```

### Rules

- **Date header:** `# YYYY-MM-DD`, one per calendar day, newest first.
- **Bullet:** `- {emoji} {HH:mm} {summary}{anchor?}`
  - `emoji`: `🔴` pivotal · `🟡` question · `🟢` context
  - `HH:mm`: local time (24h)
  - `summary`: third-person fact extracted from the message, ≤ 140 chars, no
    bold/italic/code-fences, no `USER STATED:` / `AGENT NOTED:` boilerplate.
  - `anchor?`: ` {shortId}` — optional, last 6 chars of the source msg-ID.
    Resolves via `observations-evidence.json` to full msg-ID, excerpt, actor.
- **Sub-bullet:** 2-space indent, max 1 level deep. Use only when the detail
  semantically belongs to the parent. No timestamp, no emoji, no anchor.
- **No other markdown syntax.** No headings beyond `#`, no nested lists
  beyond one level, no inline code, no links. Tokens matter.

### Anchor short ID

Source message IDs follow the pattern `msg-{epoch}-{shortId}` where `shortId`
is a 6-char base36 suffix. The Observer emits only the `shortId` to save
tokens. The Sidecar resolves it back.

If the source message-ID does not match the pattern, fall back to the last
6 chars of the full ID.

## Sidecar `observations-evidence.json`

```json
{
  "u5luxw": {
    "fullMessageId": "msg-1778338128969-u5luxw",
    "messageRangeTo": "msg-1778338128969-u5luxw",
    "excerpt": "Tradeoffs werden ja nicht mehr dekontextualisiert aufgelöst.",
    "actor": "user",
    "createdAt": "2026-05-09T14:49:14.493Z",
    "anchorRefs": [
      {
        "type": "feature",
        "id": "66c67c77-67c6-41c0-9065-c4fe651d8404",
        "title": "Entscheidungsrahmen"
      }
    ]
  }
}
```

Key = `shortId` from the Markdown bullet. Value carries everything the LLM
does NOT need but the UI / echo-detection / cross-session retrieval DO.

When two bullets share the same `shortId` (rare, but possible if multiple
observations are extracted from the same source message), the latest write
wins. UI must accept that one Sidecar entry can back several bullets.

## What the main model sees

`<session_memory>` block in the system prompt:

```
<session_memory>
Structured observations from past conversation turns. These persist across
compaction — the agent does NOT need to re-derive them.

# 2026-05-11
- 🔴 17:38 User reported 240k-token session without observer trigger
- 🟡 17:43 Open question: how does streaming mode work?

15 observations total, showing 12
</session_memory>
```

Note: anchors `{shortId}` are stripped before injection — they're only useful
for the Sidecar/UI lookup. The main model sees the readable bullets without
them, saving ~8 chars × N bullets.

## Validation regex

For parser tests and tooling, the canonical bullet regex is:

```
^(?<indent>  )?- (?<emoji>🔴|🟡|🟢) (?<time>\d{2}:\d{2}) (?<summary>.+?)(?:\s\{(?<anchor>[a-z0-9]+)\})?$
```

Sub-bullets (with 2-space indent) carry no emoji/time/anchor — they're prose
only. Separate regex:

```
^  - (?<text>.+)$
```

## What this format is NOT

- **Not a database.** Don't add fields. If you need more structure, put it in
  the Sidecar.
- **Not multi-level nesting.** Two levels max. If a thought needs three
  levels, split into multiple top-level bullets.
- **Not chronologically strict within a day.** Bullets within a date group
  may be reordered by the Reflector (e.g., to merge question + answer).
- **Not append-only after Reflector runs.** The Reflector rewrites the file.
  Anything outside the Sidecar that relied on bullet identity will break —
  use anchors instead.
