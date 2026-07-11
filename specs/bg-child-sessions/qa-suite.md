# End-to-End QA Suite — Entkoppelte Background-Subagents via Child-Sessions

Scope: verifies the externally visible behavior specified in the four sibling
`.feature` files, strictly at the **user interface** of the Electron app. No
project API, no direct file/registry inspection of internals — the only
non-GUI affordances used are **launch environment variables** (a CLI-level
user affordance) and **chat prompts to the agent** (whose tool answers render
in the transcript, e.g. `list_background_tasks`).

Conventions used by every test:

- **Launch(env…)** — quit the app fully, relaunch it from a terminal with the
  given environment variables. `unset` means the variable is removed from the
  environment.
- **Parent session** — a fresh session created via the UI in a workspace with
  at least one configured LLM connection, permission mode `allow-all` unless
  stated otherwise.
- **Background prompt** — a chat message of the form:
  “Starte eine Hintergrund-Recherche zu <topic> als Background-Task; ich
  arbeite hier weiter.” (phrased so the agent chooses background execution).
- **Sync prompt** — “Nutze einen Subagenten, um <question> zu beantworten,
  und gib mir das Ergebnis in dieser Antwort.” (in-turn, agent waits).
- **Introspection prompt** — “Liste deine Background-Tasks auf.” (drives
  `list_background_tasks`; the answer renders in the transcript).
- **Observation check** — open the session's Observations panel (session
  scope) in the UI and read the latest entries.
- **Context check** — read the context-% indicator shown for the session
  before/after turns.

Pass criteria are per-step; a test fails on the first unmet expectation.

---

## QA-R — Routing (bg-child-routing)

### QA-R-1 Background attempt becomes a child session (routing-01, -03 proxy)
1. Launch(`ORCHA_STREAMING_MODE=1`, `ORCHA_BG_CHILD_SESSIONS` unset).
2. Open a parent session; note the session count in the session list.
3. Send a Background prompt (topic: “Konkurrenzanalyse Craft Agents”).
4. **Expect:** before the assistant's answer completes, a new session appears
   in the session list whose name/first message matches the delegated task.
5. **Expect:** the parent's answer states that the work runs as a separate
   background session (no error surfaced to the user).
6. **Expect:** the parent turn ends normally (input becomes available again).
7. Open the new child session. **Expect:** its transcript starts with the
   delegated prompt and it is processing or has processed independently.

### QA-R-2 Gate matrix (routing-02, -06)
Repeat the following for each row; between rows, fully relaunch.

| # | Launch env | Prompt | Expected UI outcome |
|---|---|---|---|
| a | `ORCHA_STREAMING_MODE=1` | Background prompt | new child session appears (as QA-R-1) |
| b | `ORCHA_STREAMING_MODE=1 ORCHA_BG_CHILD_SESSIONS=1` | Background prompt | new child session appears |
| c | `ORCHA_STREAMING_MODE=1 ORCHA_BG_CHILD_SESSIONS=0` | Background prompt | **no** new session; task runs as in-query background task (chip appears, upstream behavior) |
| d | `ORCHA_STREAMING_MODE=0` | Background prompt | **no** new session; upstream in-query background task |
| e | `ORCHA_STREAMING_MODE=1` | Sync prompt | **no** new session; answer contains the subagent result within the same reply |

### QA-R-3 Child inherits parent context (routing-04)
1. Launch(`ORCHA_STREAMING_MODE=1`).
2. Create a parent session; via UI set a non-default model (e.g. Haiku) and
   permission mode `ask`; enable at least one source.
3. Send a Background prompt.
4. Open the spawned child session's info/header UI.
5. **Expect:** child shows the same model, permission mode `ask`, the same
   enabled source, and the same working directory as the parent.

---

## QA-F — Result feedback (bg-child-result)

### QA-F-1 Completed child notifies idle parent (result-01 completed, -02)
1. Launch(`ORCHA_STREAMING_MODE=1`).
2. In a parent session, send a Background prompt for a short task
   (“Fasse README.md des Projekts in 3 Sätzen zusammen”).
3. Leave the parent idle (send nothing further). Wait for the child session
   to finish (its status/spinner in the session list stops).
4. **Expect:** without any user action, the parent session starts a new turn
   whose incoming message contains a `background_result` block with
   `status="completed"`, the task name, the child session id, and the child's
   final answer text.
5. **Expect:** the parent's assistant reply references/uses that result.

### QA-F-2 Busy parent gets the result after its turn (result-03)
1. Same setup as QA-F-1, but immediately after spawning, send the parent a
   long-running prompt (e.g. “Zähle ausführlich alle Dateien im Repo auf und
   beschreibe jede kurz”) so the parent is mid-turn when the child finishes.
2. **Expect:** the parent's running turn completes uninterrupted.
3. **Expect:** after that turn ends, the `background_result` message is
   processed as the next turn (visible in the transcript order).

### QA-F-3 Failed child reports failure (result-01 failed)
1. Launch(`ORCHA_STREAMING_MODE=1`).
2. Send a Background prompt engineered to fail (e.g. delegate reading a
   nonexistent absolute path with instruction to error out, or pick a child
   model/connection that is not authenticated).
3. **Expect:** parent receives one `background_result` block with
   `status="failed"` and the child's last error text. Nothing is silently
   swallowed (no child that ends in error without a parent notification).

### QA-F-4 Exactly one notification per child (result-04)
1. Run QA-F-1 to completion.
2. Open the child session and send a follow-up user message there; wait for
   that turn to finish.
3. **Expect:** the parent session receives **no** second `background_result`
   message for this child (transcript unchanged apart from QA-F-1's one).

### QA-F-5 Oversized result is truncated with pointer (result-05)
1. Launch(`ORCHA_STREAMING_MODE=1`).
2. Background prompt: instruct the child to output a text clearly larger than
   the configured cap (e.g. “Erzeuge eine Aufzählung mit 2000 nummerierten
   Zeilen à ~50 Zeichen als finale Antwort”).
3. **Expect:** the parent's `background_result` body is visibly truncated
   (≤ cap) and names the child session as the place to read the full result;
   opening the child session shows the full text.

### QA-F-6 Result lands in observations (result-06)
1. Run QA-F-1 to completion, let the parent finish processing the result.
2. Observation check on the parent.
3. **Expect:** the observation ledger contains a new observation describing
   the background task's outcome (task recognizable by name/topic).

---

## QA-V — Visibility (bg-child-visibility)

### QA-V-1 Running chip + introspection (visibility-01)
1. Launch(`ORCHA_STREAMING_MODE=1`).
2. In a parent session, send a Background prompt for a task long enough to
   observe while running (≥ 1 minute).
3. **Expect:** a running-task chip appears above the parent's input, labeled
   with the task.
4. Send the Introspection prompt in the parent.
5. **Expect:** the rendered answer lists an entry whose task id equals the
   child session's id, status `running`, kind `child-session`.

### QA-V-2 Survives turn end — no orphaning (visibility-02)
1. Continue from QA-V-1 while the child is still running.
2. Send 1–2 trivial parent messages so the spawning turn is clearly over.
3. Send the Introspection prompt again.
4. **Expect:** the child's entry still shows `running`; **no** entry for it
   shows `orphaned`; the chip is still present.

### QA-V-3 Completion is visible (visibility-03)
1. Wait for the child from QA-V-1 to finish.
2. **Expect:** the chip changes to a completion state (or disappears in favor
   of the completion chip), and the Introspection prompt now reports a
   terminal status (not `running`, not `orphaned`).

### QA-V-4 Retention cleanup (visibility-04)
1. After QA-V-3, keep the app open for > 1 hour (or perform the wait in a
   scheduled QA run).
2. Send the Introspection prompt.
3. **Expect:** the finished child's entry is no longer listed.

---

## QA-K — Keep-alive resolution (bg-child-keepalive)

### QA-K-1 Streaming mode: fresh query per turn, shrinking context (keepalive-01 rows 1–2, -02)
1. Launch(`ORCHA_STREAMING_MODE=1`) — once with `CRAFT_KEEP_BG_AGENTS_ALIVE`
   unset, once with `=1` (two passes; expectation identical, proving
   streaming wins).
2. In a session, hold a conversation long enough that observations exist
   (Observation check shows entries).
3. Context check, then send 3 further substantial messages, Context check
   after each.
4. **Expect:** context % does not grow monotonically with raw history — after
   observation replacement kicks in, it drops or plateaus below what the
   accumulated transcript would imply.

### QA-K-2 End-to-end (keepalive-03)
1. Launch(`ORCHA_STREAMING_MODE=1`).
2. Background prompt for a multi-minute task; **expect** child running +
   parent turn ends (QA-R-1 criteria).
3. Send 2 further parent messages; **expect** context % behavior as QA-K-1.
4. Wait for child completion; **expect** exactly one `background_result`
   turn (QA-F-1) and a matching observation (QA-F-6).

### QA-K-3 Upstream regression guard (keepalive-01 rows 3–5, -04)
1. Launch(`ORCHA_STREAMING_MODE=0`), `CRAFT_KEEP_BG_AGENTS_ALIVE` unset.
2. Send a Background prompt.
3. **Expect:** no child session is created; an in-query background task chip
   appears (upstream behavior).
4. Send a trivial follow-up message ending the spawning turn, then the
   Introspection prompt.
5. **Expect:** the task is reported `running` (not `orphaned`) — the
   persistent query kept it alive.
6. Relaunch with `CRAFT_KEEP_BG_AGENTS_ALIVE=0`, repeat 2–4.
7. **Expect:** after the spawning turn ends, the task is reported `orphaned`
   (per-turn kill-switch, upstream fallback semantics).

---

## Traceability

| Gherkin scenario | QA test |
|---|---|
| bg-child-routing-01 | QA-R-1 |
| bg-child-routing-02 | QA-R-2 (a–e) |
| bg-child-routing-03 | QA-R-1 step 4/7 (UI proxy: child exists + linked task) |
| bg-child-routing-04 | QA-R-3 |
| bg-child-routing-05 | QA-R-2 (e) |
| bg-child-routing-06 | QA-R-2 (c) |
| bg-child-result-01 | QA-F-1, QA-F-3 |
| bg-child-result-02 | QA-F-1 |
| bg-child-result-03 | QA-F-2 |
| bg-child-result-04 | QA-F-4 |
| bg-child-result-05 | QA-F-5 |
| bg-child-result-06 | QA-F-6 |
| bg-child-visibility-01 | QA-V-1 |
| bg-child-visibility-02 | QA-V-2 |
| bg-child-visibility-03 | QA-V-3 |
| bg-child-visibility-04 | QA-V-4 |
| bg-child-keepalive-01 | QA-K-1, QA-K-3 |
| bg-child-keepalive-02 | QA-K-1 |
| bg-child-keepalive-03 | QA-K-2 |
| bg-child-keepalive-04 | QA-K-3 |

Note: bg-child-routing-03's metadata assertions (`parentSessionId`,
notify-on-complete marker) are not directly visible in the GUI; QA verifies
them via their observable consequences (child appears, exactly one result
message arrives). The direct assertions are covered by the coder's
integration tests, not this UI suite.
