# bg-child-sessions — QA Report (final independent verification)

QA session: `260710-nimble-trail`. Verified branch `swarm/bg-child-sessions` at tip
`180dff79`, against the packaged Electron app (Orcha Agents fork) running live with
Chrome DevTools Protocol on `127.0.0.1:9333`. All tests below were run **through the
UI** (CDP-driven DOM interaction + chat prompts), never via a project API. On-disk
session state (`session.jsonl`, `meta/context-trace.jsonl`, `data/observations.mastra.md`)
was read as observable durable state, per the QA mandate.

Own test sessions created (all prefixed for identification, all in workspace
`my-workspace`, never touching pre-existing sessions):
`260710-prime-plain`, `260710-azure-marsh`, `260710-rapid-cloud`, `260710-early-silver`
(primary — most scenarios chained here), plus their spawned children
(`260710-golden-lion`, `260710-copper-thunder`, `260710-smooth-bloom`, `260710-pure-hill`,
`260710-grand-dolphin`, `260710-ready-heath`, `260710-safe-breeze`).

## Verdict summary

| Scenario | Test | Result |
|---|---|---|
| **bg-child-keepalive-02** | QA-K-1 | **PASS** |
| **bg-child-keepalive-03** | QA-K-2 | **PASS** |
| **bg-child-routing-01** | QA-R-1 | **PASS** |
| **bg-child-visibility-01** | QA-V-1 | **PARTIAL — FAIL** on the running-chip assertion |
| bg-child-visibility-02 | QA-V-2 | PASS (introspection half); chip half inherits V-1's FAIL |
| bg-child-visibility-03 | QA-V-3 | PASS |
| bg-child-visibility-04 | QA-V-4 | NOT-RUN (needs 1h+ wall-clock) |
| bg-child-result-01 (completed) / -02 | QA-F-1 | PASS |
| bg-child-result-01 (failed) | QA-F-3 | NOT-RUN (see below) |
| bg-child-result-03 | QA-F-2 | NOT-RUN (see below) |
| bg-child-result-04 | QA-F-4 | PASS |
| bg-child-result-05 | QA-F-5 | PASS |
| bg-child-result-06 | QA-F-6 | PASS |
| bg-child-routing-02 (rows a, e) | QA-R-2 (partial) | PASS |
| bg-child-routing-02 (rows b, c, d) | QA-R-2 (partial) | NOT-RUN at UI level (unit-tested) |
| bg-child-routing-03 | QA-R-1 proxy | PASS (observable-consequence proxy, per suite note) |
| bg-child-routing-04 | QA-R-3 | PASS |
| bg-child-routing-05 | QA-R-2(e) | PASS |
| bg-child-routing-06 | QA-R-2(c) | NOT-RUN at UI level (unit-tested) |
| bg-child-keepalive-01 | QA-K-3 | NOT-RUN at UI level (unit-tested, 5/5 rows per coder) |
| bg-child-keepalive-04 | QA-K-3 | NOT-RUN at UI level (unit-tested) |

**One confirmed bug**, scoped to this feature (see below). No other regressions found.

---

## Priority 1 — bg-child-keepalive-02 / -03 (full detail)

### Testability note (read first)

Both scenarios require `"a session is open with enough history that observations
exist"`. The Mastra observer's token-trigger estimates backlog as
`raw session.jsonl bytes since watermark / 4` (see
`packages/shared/src/sessions/observation-trigger.ts:96-131`), and only fires above
`ORCHA_OBSERVER_THRESHOLD_TOKENS` (default 24000, i.e. **~96KB of raw transcript**).
Reaching that organically needs dozens of substantial turns — directly at odds with
this QA pass's "minimal prompts, tiny background tasks" budget mandate.

To make the mechanism testable within budget, I relaunched the app with
`ORCHA_OBSERVER_THRESHOLD_TOKENS=300 ORCHA_OBSERVER_MIN_INTERVAL_SECONDS=5` — both are
legitimate CLI-level launch environment variables, the same affordance class as
`ORCHA_STREAMING_MODE` that the suite's own "Launch(env…)" convention sanctions. This
does not touch the bg-child-sessions feature code; it only tunes an existing,
independent, already-shipped observer-trigger knob. `ORCHA_STREAMING_MODE` and
`ORCHA_BG_CHILD_SESSIONS` were left unset (both default ON), matching the scenarios'
`Given` clauses. This is worth flagging to the conductor as a **general QA testability
gap** in the observer infra (not a bug in this feature) — future QA passes on
observation-dependent behavior will hit the same wall.

### bg-child-keepalive-02 — PASS

Session `260710-early-silver`. After the lowered threshold made the observer fire once
(confirmed: `data/observations.mastra.md` and `meta/observation-watermark.json`
appeared), sent 3 further turns and recorded `meta/context-trace.jsonl` after each:

```
inputTokens=39609 replacement=false sdkResume=true   (before observations existed)
inputTokens=31151 replacement=true  sdkResume=false   (turn 1 after observations)
inputTokens=31079 replacement=true  sdkResume=false   (turn 2)
inputTokens=30684 replacement=true  sdkResume=false   (turn 3)
```

Exact match to the scenario: `replacement:true` and `sdkResume:false` ("each turn
served by a fresh agent query") on every turn once observations exist, and
`inputTokens` **drops and plateaus** (39609 → ~31000) rather than continuing the prior
turns' growth trend (32975 → 35369 → 37714 → 39609, ~2000/turn) that raw history would
have produced.

### bg-child-keepalive-03 — PASS (full E2E chain, same session)

1. Background prompt for task `e2e-background-run` (topic: summarize Bun.sh, 5
   sentences) → agent called `spawn_session` → child `260710-pure-hill` created →
   parent's turn ended normally ("Du kannst hier normal weiterarbeiten…").
2. Sent 2 further parent messages (arithmetic questions). `context-trace.jsonl` for
   these turns: `32964 → 31871 → 32078 → 32069` — **not monotonically growing**
   (plateaus/dips despite more turns and the background-result injection).
3. Child's first turn ended with success; parent received the result as
   `<background_result task="e2e-background-run" childSessionId="260710-pure-hill"
   status="completed">…</background_result>` — confirmed **exactly one** occurrence via
   `grep -c` on the session transcript.
4. Observation ledger (`data/observations.mastra.md`) gained a new bullet: *"✅ (22:47)
   Background task 'e2e-background-run' (session 260710-pure-hill, model
   claude-opus-4-8) completed successfully. Delivered Bun.sh summary…"* — an
   observation about the named result, as required.

---

## Priority 2 — bg-child-routing-01 — PASS

Session `260710-early-silver`, explicit turn: instructed the agent to call the
built-in `Agent`/`Task` tool directly with `run_in_background: true` (necessary to
force the actual gate path — left to its own judgment, the agent reaches for
`spawn_session` directly via `ToolSearch`, bypassing the gate entirely; both are
legitimate agent behaviors, but only the forced-tool-call path exercises the PreToolUse
Step-0 gate itself).

Observed in the same turn, in order:
1. `Agent({run_in_background: true, ...})` → **denied**, tool result:
   `"[ERROR] Background subagents run as independent child sessions in this app. Use
   `spawn_session` with your prompt; the result will be delivered to you automatically
   as a message. For parallel work you want to wait on, call Agent without
   run_in_background."` — deny reason **names `spawn_session`**, matches spec exactly.
2. Same turn, agent self-corrected and called `spawn_session` → child session
   `260710-smooth-bloom` created — **before the turn ended**.
3. Turn ended normally with a summary table confirming denial → fallback → automatic
   result delivery, then the `background_result` for `260710-smooth-bloom` arrived
   (`status="completed"`, content `"8"`) and was surfaced in the next turn.

All `Then` clauses of the scenario verified directly from the live transcript.

---

## Priority 3 — bg-child-visibility-01 / -03

### bg-child-visibility-03 — PASS

Completion is visible two ways, both confirmed:
- **Chip:** `<button title="e2e-background-run — Finished in the background">` appears
  once the child finishes (confirmed for 3 separate completed children:
  `e2e-background-run`, `chip-test`, `chip-test-2`).
- **Introspection:** `list_background_tasks` reports a terminal `status` (`"completed"`),
  never `"orphaned"`, `kind: "child-session"`.

### bg-child-visibility-01 — PARTIAL, **confirmed bug on the running-chip assertion**

The introspection half **passes**: while a child session was genuinely running (~40s,
confirmed via its own transcript actively doing web searches), `list_background_tasks`
correctly reported:
```json
{"taskId": "260710-grand-dolphin", "intent": "chip-test", "status": "running",
 "startTime": ..., "elapsedSeconds": 37, "kind": "child-session"}
```

The **chip half fails**: polled the live DOM (`button[title]`, `button.rounded-full`,
and a broad text-content sweep) repeatedly across two separate genuinely-running child
sessions (`chip-test` → `260710-grand-dolphin`, `chip-test-2` → `260710-ready-heath`,
each running 30–40+ seconds with confirmed active tool use in their own transcripts).
**Zero chip elements ever appeared while running** — only the terminal
`"— Finished in the background"` chip appears, and only after completion.

**Root cause** (traced via code investigation, not just symptom): two independent chip
mechanisms exist in the renderer:
- `BackgroundFinishedChip` (`apps/electron/src/renderer/components/app-shell/BackgroundFinishedChip.tsx`)
  — the chip observed above. Terminal-only **by design**; fires off a whole-session
  `complete` event, not a running-state signal.
- `ActiveTasksBar` (`apps/electron/src/renderer/components/app-shell/ActiveTasksBar.tsx`)
  — the actual mechanism for a **running**-task chip, fed by
  `backgroundTasksAtomFamily`, populated only when a `task_backgrounded` /
  `shell_backgrounded` renderer event arrives (`App.tsx`'s `handleBackgroundTaskEvent`).

`task_backgrounded` events are emitted only for `Task`/`Agent`/`Workflow` tool calls
(`PARENT_TASK_TOOLS`, `packages/shared/src/utils/toolNames.ts:35`, plus a separate
`Workflow` detector) via transcript-signature scanning in
`packages/shared/src/agent/tool-matching.ts`. **`spawn_session` is not in that set and
never emits `task_backgrounded`.** `SessionManager.ts`'s `onSpawnSession` (~line 4223)
only writes into the server-side `backgroundTaskRegistry` (which is what
`list_background_tasks` reads) — it never calls `this.sendEvent({type:
'task_backgrounded', ...})`. So `kind: 'child-session'` entries never reach
`ActiveTasksBar`, and no running-chip renders for them; they only ever appear once
terminal, via the unrelated `BackgroundFinishedChip` path.

This is squarely in this feature's own scope: the Phase-3 checkpoint entry (commit
`21bf6c11`) explicitly states the registry wiring was added "so the **existing chip
UI**… report[s] the child truthfully" — but the event emission needed to actually drive
that chip while running was never added. `specs/bg-child-sessions/bg-child-visibility.feature`
scenario 01 explicitly requires the running chip, so this is a genuine, reproducible gap
against the accepted spec, not a flaky UI timing issue (confirmed with two independent
running children, ~40s and ~44s of active running time each, polled every few seconds).

**Not fixed in this QA pass** — the minimal correct fix (emit a `task_backgrounded`-
shaped event from `onSpawnSession`, extend the DTO's `kind` union from
`'workflow'` to `'workflow' | 'child-session'`, and confirm `ActiveTasksBar` renders
`'child-session'` kind sensibly) touches the shared DTO, `SessionManager.ts`, and
renderer state — multi-file, needs an app rebuild to re-verify live, i.e. not the
"minimal, single-site" fix budget-aware QA fixes are meant for. Escalating instead of
patching, per the swarm-testing guardrail to stop and ask before taking non-minimal
QA-owned changes; see checkpoint `## Open questions`.

### bg-child-visibility-02 — PASS (introspection), inherits V-1's chip caveat

Confirmed via `list_background_tasks` across multiple parent turns while a child was
still running: status stayed `"running"`, never flipped to `"orphaned"` after the
spawning turn ended. The suite's "chip is still present" sub-clause cannot be verified
independently of the V-1 finding above, since no running chip appears at all for
`kind: 'child-session'` tasks.

---

## Remaining suite items (budget-permitting), what got covered incidentally

Several of these were confirmed as side effects of the priority-1/2/3 E2E runs above,
at effectively zero extra cost:

- **bg-child-result-01(completed)/-02** — PASS. Confirmed across 4 independent
  completed children (`smooth-bloom`, `pure-hill`, `grand-dolphin`, `ready-heath`):
  `background_result` block present with `status="completed"`, task name, child session
  id, final text; parent's reply references/uses the result each time.
- **bg-child-result-04** — PASS. `grep -c` on `260710-early-silver`'s transcript
  confirmed exactly one `background_result task="e2e-background-run"` block, no
  duplicate even after a later unrelated turn.
- **bg-child-result-05** — PASS. Deliberately requested an oversized report
  (`chip-test-2`); measured body length **16275 bytes** (at/under cap) with trailing
  `"[Result truncated — read the full output in child session 260710-ready-heath.]"`
  pointer; the child session's own transcript held the full, untruncated report.
- **bg-child-result-06** — PASS. Same evidence as keepalive-03 above (observation
  ledger entry naming the completed task).
- **bg-child-result-01(failed)/QA-F-3** — **NOT-RUN**. Attempted (`fail-test` task:
  instructed the child to read a nonexistent absolute path and abort on failure). The
  child agent gracefully absorbed the tool error and returned prose describing the
  failure, terminating with `status="completed"` (not `"failed"`) — i.e. this exercised
  graceful-error-handling, not the SDK/agent-level `"failed"` terminal-status code path.
  Forcing a genuine `"failed"` status reliably via natural chat prompting (vs. e.g. an
  unauthenticated connection or invalid model) wasn't attempted further given budget;
  the failed-status code path itself is unit-tested by the hardener
  (`getSessionLastErrorText` edge cases, deny-reason exact-string assertion).
- **bg-child-result-03 (busy parent)** — NOT-RUN. Every background task in this pass
  completed in 2–40s — faster than a parent prompt long enough to still be mid-turn
  when the child finishes could reliably be arranged within budget.
- **bg-child-routing-02** rows **a** (`streaming=1,flag=unset,bg=true→denied`) and **e**
  (sync, no bg flag→allowed, in-turn) — PASS, directly observed (routing-01 test above,
  and a dedicated sync-subagent turn: "Hauptstadt von Frankreich" answered in-turn via
  `Agent` without `run_in_background`, no child session created).
  Rows **b/c/d** (flag=1; flag=0; streaming=0) — NOT-RUN at UI level; each needs a full
  app relaunch with different launch env vars, not attempted given budget. High
  confidence from the hardener's pass (17/17 mutation kill rate on the Step-0 gate
  block, all 6 matrix rows unit-tested).
- **bg-child-routing-03** — PASS via observable consequence (per the suite's own note
  that direct assertions aren't GUI-visible): child's `session.jsonl` header carries
  `parentSessionId` set to the correct parent id; exactly-once result delivery
  (bg-child-result-04 above) confirms the notify-on-complete wiring functions.
- **bg-child-routing-04** — PASS. Diffed `session.jsonl` headers of parent
  `260710-early-silver` (`model: claude-opus-4-8, permissionMode: allow-all,
  enabledSourceSlugs: []`) vs. child `260710-ready-heath` (identical on all three) —
  inheritance confirmed without overrides.
- **bg-child-routing-05/06** — PASS via the sync-subagent test above (05); kill-switch
  row (06, `flag=0`) NOT-RUN at UI level, same relaunch cost as routing-02 rows b/c/d;
  unit-tested per hardener.
- **bg-child-keepalive-01 matrix / -04** — NOT-RUN at UI level (needs
  `ORCHA_STREAMING_MODE=0` relaunches); unit-tested (coder's phase-4 pass, all 5 matrix
  rows + dedicated keepalive-04 test, both green per checkpoint).
- **bg-child-visibility-04** (retention cleanup after 1h+) — NOT-RUN, infeasible within
  this session's time budget; recommend a scheduled follow-up QA run if this needs
  direct UI confirmation (the underlying cleanup logic itself was validated in the
  coder's phase-3 unit tests per checkpoint).

## Incidental environment notes (not bugs)

- New sessions default to **Explore** permission mode, which correctly blocks
  `spawn_session` (a session-configuration-changing tool) with a clear message pointing
  at Shift+Tab to switch modes — expected guardrail behavior, not a defect. Affected my
  first test attempt (`260710-prime-plain`); switched to Execute mode via the UI and
  retried successfully.
- The model tested here (`claude-opus-4-8`) sometimes reaches for `spawn_session`
  directly via its own `ToolSearch` rather than going through `Agent`/`Task` with
  `run_in_background: true` when phrasing leaves it the choice — both are legitimate,
  intended behaviors per the feature design (`spawn_session` is the blessed entry
  point either way), but it means most natural-language "background prompt" tests
  exercise the downstream machinery (child creation, result feedback, visibility,
  keep-alive) without touching the PreToolUse gate itself. Only forced,
  tool-explicit prompts (as used for routing-01) exercise the gate/deny/reroute path.

## Gates

- No code changes made in this QA pass except the report/checkpoint itself — deferred
  to the hardener's already-clean CRAP/DRY pass over the unchanged feature diff scope
  (`git diff --name-only 88669bc1 HEAD`); re-running CRAP/DRY on an unmodified diff
  would be redundant.
- `bun run typecheck:all` not re-run (no code touched this session); hardener's last
  gate: 0 errors, unchanged.

## Merge recommendation (for conductor to relay to the user)

Functionally the feature works end-to-end and correctly for the two highest-priority
deferred scenarios (keepalive-02/-03) and the core routing gate (routing-01), plus
result-feedback, truncation, exactly-once delivery, and observation recording all
verified live. The **one confirmed defect** — no running-state chip for `child-session`
background tasks (bg-child-visibility-01) — is a real, spec-contradicting gap, but it is
a **visibility/polish** issue (the task is fully tracked and reported correctly via
`list_background_tasks`; users simply don't get a live visual indicator while it runs,
only a *retroactive* "finished" chip once it's done). Not data-loss, not a correctness
bug in the background-execution model itself. Recommend:
either merge with this logged as a fast-follow, or route back to coder/cleaner for the
scoped fix identified above before merge — a call for the user, not for QA to make
unilaterally.

---

## p5 verify — mini-verify of the running-chip fix (commit `529d94a7`)

QA session: `260710-gentle-gorge`. Scope: **not** a full suite re-run — verified exactly
the fix from `.swarm/checkpoint.md` § "p5 running-chip fix" against the previously
confirmed defect (bg-child-visibility-01) plus a quick regression glance at -03.
Packaged Electron app relaunched from the `529d94a7` build (confirmed live: `main.cjs`
contains 4 occurrences of `task_backgrounded`; renderer `assets/` bundle contains
`child-session`), CDP on `127.0.0.1:9333`, all interaction through the UI (DOM
click/insertText via `Runtime.evaluate`, no project API). Own test session
`260710-tall-bay` (auto-titled "Background Session Spawning" from the first prompt;
`QA-P5:` was the literal prompt-text prefix used per the mandate), two children spawned
in it: `260710-calm-aspen` (Bun.sh summary) and `260710-quiet-coral` (TCP history
summary).

### bg-child-visibility-01 — **PASS** (previously FAIL, now fixed)

Second spawn (`TCP history summary`, deliberately given a longer research prompt to
widen the observation window) polled at 2s intervals via `document.querySelectorAll`
over the live DOM:

| t (wall) | Observed chip state |
|---|---|
| 2s–9s | `button[title="Click for task actions"]` textContent `"TaskTCP history summary" + <elapsed>` (2s → 4s → 6s → 9s) — **running chip, visible above the input, elapsed counter live** |
| 11s | Child completes; `list_background_tasks`-independent terminal `BackgroundFinishedChip` (`title="TCP history summary — Finished in the background"`) appears *alongside* the still-present running chip |
| 13s–18s | Running chip persists briefly post-completion (elapsed frozen), both chips coexist |
| 18s (next poll) | Running chip text flips to `"TaskTCP history summarydone"` — terminal state received |
| 26s+ | Running chip **gone** from DOM; only the `BackgroundFinishedChip` remains |

This is the exact `task_backgrounded` → running-chip → `task_completed` → clear
lifecycle the checkpoint note describes. Root cause from the prior QA pass (`spawn_session`
never emitted `task_backgrounded`, so `ActiveTasksBar` never saw `kind:'child-session'`
tasks) is confirmed fixed: the chip now renders live while the child runs and clears on
terminal state, matching bg-child-visibility-01's `Then` clauses in full (both the
running-chip half and the clear-on-terminal half, which -01 also specifies).

### bg-child-visibility-03 regression — **PASS** (still passing, quick glance)

`BackgroundFinishedChip` (`title="TCP history summary — Finished in the background"` /
`"Bun.sh summary — Finished in the background"`) still appears correctly for both
completed children — unaffected by the fix, as expected (it's a separate mechanism from
`ActiveTasksBar`).

### Regression glance — exactly-once `background_result` delivery

On-disk transcript (`~/.orcha-agents/workspaces/my-workspace/sessions/260710-tall-bay/session.jsonl`)
checked for `background_result` occurrences: exactly 2 total, one per spawned child, each
with a distinct `childSessionId` and `status="completed"`:
```
("Bun.sh summary", "260710-calm-aspen", "completed")
("TCP history summary", "260710-quiet-coral", "completed")
```
No duplicate/missing deliveries — exactly-once holds per child, consistent with the
already-PASS bg-child-result-01/-02.

### Verdict

**PASS.** The only outstanding defect from the original QA report (bg-child-visibility-01)
is fixed and verified live; no regression on the adjacent -03 scenario or on
exactly-once result delivery. Combined with the rest of `qa-report.md` above (unchanged
by this fix, per the checkpoint's "exactly these 5 files" scope), the feature is now
**ready for the merge decision with no known open defects.**
