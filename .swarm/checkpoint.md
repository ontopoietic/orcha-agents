# bg-child-sessions — checkpoint

## FEATURE COMPLETE (all 4 phases) — see per-phase sections below

- **Phase 1 (Routing)** — `bg-child-routing.feature`, all 6 scenarios. PreToolUse Step-0 gate
  (streaming+flag → reroute Agent/Task `run_in_background` to `spawn_session`), spawn-option
  inheritance (`buildSpawnedChildSessionOptions`). Commit `656971a4`.
- **Phase 2 (Result Feedback)** — `bg-child-result-feedback.feature`, all 6 scenarios.
  `notifyParentOnChildComplete` watcher (exactly-once, `<background_result>` wrapper,
  last-error-text on failure); fixed a 16KB-total-cap bug (pointer was appended after
  capping, could exceed the cap). Commit `79f27116`.
- **Phase 3 (Registry/UI Visibility)** — `bg-child-visibility.feature`, all 4 scenarios.
  `buildChildSessionBackgroundTaskEntry`, terminal-status mirroring validated, retention
  cleanup validated; fixed an orphan-sweep bug (`markOrphanedBackgroundTasks` was orphaning
  `kind:'child-session'` entries too — now guarded). Commit `21bf6c11`.
- **Phase 4 (Keep-Alive Resolution)** — `bg-child-keep-alive.feature`, this session. See below.

## Phase 4 — Done
- Scenario 01 (lifecycle matrix, all 5 rows): already existed as validated inherited WIP in
  `packages/shared/src/agent/core/__tests__/bg-child-sessions.test.ts` (`keep-alive lifecycle
  matrix (bg-child-keepalive-01)` describe block) — confirmed it exercises the exact
  production expression (`resolveKeepBackgroundTasksAlive() && !isStreamingModeEnabled()`,
  mirrored from `claude-agent.ts`'s private `keepBackgroundTasksAlive` field) across all 5
  streaming×keepAlive rows from the feature file. No changes needed; validated, not rewritten.
- Scenario 04 (upstream regression guard, streaming off): added a dedicated
  `bg-child-keepalive-04` test to the same file — resolution-side half (streaming=0,
  keepAlive=unset → keep-alive resolves ON), directly traceable to the scenario name without
  duplicating the full matrix. The routing-side half (no child session created because the
  PreToolUse gate doesn't intercept when streaming is off) is the existing phase-1 gate-matrix
  row `streaming=0 flag=unset background=true -> allowed` in
  `packages/shared/src/agent/core/__tests__/pre-tool-use-checks.isolated.ts` — referenced by
  comment, not duplicated.
- ORCHA-fork comment block above `keepBackgroundTasksAlive` in `claude-agent.ts` (lines
  ~511-538): found **already updated** to describe the resolution (background work rerouted
  to child sessions per `specs/bg-child-sessions/`, streaming wins over keep-alive, upstream
  behavior preserved when `ORCHA_STREAMING_MODE=0`) — inherited from the WIP commit
  (`d4538de5`) from an earlier aborted run, not stale as the phase-4 mandate assumed. Grepped
  for "NOT yet resolved" / "not yet resolved" — no match anywhere in the file. No rewrite
  needed; content already matches the required resolution narrative.
- Confirms the phase-1 checkpoint's open question: **phase 4 was effectively already done**
  by earlier inherited WIP for its core logic; this session's job reduced to (a) validating
  that against the actual scenario text (done), (b) adding the one missing named test
  (scenario 04), and (c) confirming the comment rewrite was unnecessary.

## Deferred to QA (not this phase's job, per phase-4 mandate)
- **Scenario 02** (observation replacement reduces parent context across turns under
  streaming mode) — needs a live multi-turn session with real context-percentage
  measurement; integration-level.
- **Scenario 03** (full E2E: background work + shrinking context + observed result end to
  end) — spans spawn → routing → child turn → result-feedback → observation ledger; requires
  a real running child session and parent turn sequence. Integration/E2E-level.
- Both scenarios are QA-suite scope (per `swarm-role-coder` skill: "does not own" the
  end-to-end QA suite).

## Gates (this session)
- `bun run typecheck:all` (repo root) → 0 errors.
- `cd packages/shared && bun test` (full suite) → 3207 pass, 12 skip, 0 fail, 6163 expect()
  calls, 180 files.
- `cd packages/server-core && bun test src/sessions` → 107 pass, 0 fail, 218 expect() calls,
  18 files.

## Tried & rejected
- Considered writing a fresh, fully independent test suite for scenario 04 instead of
  reusing/extending the existing `bg-child-sessions.test.ts` file. Rejected: the resolution
  logic is a single boolean expression already covered row-by-row by the scenario-01 matrix;
  a full independent suite would just re-assert the same expression under a different name.
  Added one targeted test instead, with a comment pointing at both the matrix row it overlaps
  and the routing-side test it does not duplicate.
- Considered rewriting the ORCHA-fork comment block in `claude-agent.ts` per the phase-4
  mandate's assumption that it still said "NOT yet resolved". Rejected after grepping the
  actual file content: the comment already fully describes the resolution (rerouting to
  child sessions, streaming wins, upstream preserved when streaming off) — it was already
  fixed in the inherited WIP. Rewriting it again would have been redundant churn against
  already-correct prose.

## Cleaner pass (this session)
- Scope: files touched between `88669bc1` (spec commit) and coder's `a1bd7171` HEAD only
  (`git diff --name-only 88669bc1 HEAD`) — no unrelated fork/upstream code touched.
- Reviewed every file in that diff (`bg-child-sessions.ts`, `pre-tool-use.ts`,
  `spawn-child-session-options.ts`(+test), `child-session-background-task-entry.ts`,
  `SessionManager.ts`, `claude-agent.ts`, `system.ts`, `dto.ts`, `context.ts`, `FORK.md`,
  all four new/extended test files) for dead code, unused imports/exports, stale WIP
  comments, naming consistency, and duplication. Ran `jscpd` (min-lines 10) over the new
  production + test files — only trivial (<3%) in-file test-boilerplate overlap, nothing
  worth extracting. No dead code, unused exports, or WIP debris found — the WIP-era
  comments were already accurate (matches the phase-4 checkpoint's own finding).
- **Found and fixed one real defect:** the Step-0 background-subagent routing gate in
  `pre-tool-use.ts` (`runPreToolUseChecks`) had its `block` reason written in German —
  every other block reason in that file (and every other internal, non-i18n agent-facing
  string in the PreToolUse pipeline) is English. This is an internal steering string read
  by the LLM, not a `src/i18n/`-routed user-facing string, so the German text was a stray
  artifact, not a locale bug. Translated to English; the only test asserting on it
  (`names spawn_session in the deny reason`) checks a `toContain('spawn_session')`
  substring, unaffected. Commit `120a5c92`.
- Noted for refactorer/hardener, not fixed here (behavior-shaped, out of cleaner scope):
  `SessionManager.ts`'s `unsubscribeChildCompletionWatcher` field
  (`this.onSessionComplete(...)` return value, ~line 6549) is assigned but its
  unsubscribe function is never invoked anywhere — looks like a latent listener-leak on
  `SessionManager` disposal/recreation (e.g. hot-reload, multi-instance tests). Worth
  checking whether `SessionManager` has a dispose/teardown path that should call it.
- Gates before AND after the fix: `(cd packages/shared && bun run tsc --noEmit)` 0 errors,
  `(cd packages/server-core && bun run typecheck)` 0 errors, `(cd packages/shared && bun
  test src/agent/core)` 125 pass / 0 fail, `(cd packages/server-core && bun test
  src/sessions)` 107 pass / 0 fail. All green before and after.

## Next
- Conductor: cleaner pass complete. Next role: **refactorer** (six-pack) — see the
  `unsubscribeChildCompletionWatcher` note above as its one lead; otherwise no known
  structural issues in the `bg-child-sessions` diff.
- Deferred QA scenarios (02/03 of phase 4, plus the always-QA-owned end-to-end assertions
  from phases 1-3) still route to the specifier/QA role for the end-to-end suite, per each
  phase's "does not own" boundary — unchanged from the coder's handoff.

## Refactorer pass (this session) — no code changes

### Priority item: `unsubscribeChildCompletionWatcher` — investigated, ESCALATING (not fixed)
- Confirmed the cleaner's read: `SessionManager.ts:6549` assigns the unsubscribe closure
  returned by `this.onSessionComplete(...)` to a private field that is never read anywhere.
- Checked for a teardown path to wire it into: **`SessionManager` has no `dispose`/`close`/
  `shutdown`/`destroy` method anywhere in the class** (grepped the whole file — only
  per-*agent* disposal exists, e.g. `disposeManagedAgentRuntime`, `managed.agent.dispose()`;
  nothing disposes a `SessionManager` instance as a whole).
- Checked for a "neighboring watcher" convention to follow: **there is none** —
  `unsubscribeChildCompletionWatcher` is the only self-registered listener field of this
  shape in the class; `sessionCompletionListeners` has exactly one subscriber.
- Checked call sites: grepped the whole repo (`server-core/src`, `apps/electron/src`) for
  any `sessionManager.dispose/close/shutdown/destroy` call — **none exist**. In production
  `SessionManager` is effectively a process-lifetime singleton; in tests, instances are
  created per-`describe` and simply fall out of scope (never explicitly disposed).
- **Is it actually a leak?** No, not in the JS reference-counting sense that "leak" usually
  implies. The listener closure captures `this` and is stored on `this.sessionCompletionListeners`
  — a field of the *same* instance. This is a self-contained cycle entirely inside one
  `SessionManager` object; JS GC is reachability-based, so once nothing external holds a
  reference to that `SessionManager`, the whole self-referential graph (instance + its own
  listener set + the closure pointing back at itself) is collected together. It cannot pin
  down a stale/replaced instance on its own. The genuine risk class this pattern usually
  guards against — a *shared/global* emitter outliving per-instance listeners — doesn't
  apply here because `sessionCompletionListeners` is per-instance, not shared.
- **Why escalate instead of fixing:** the mandate says wire it into a dispose path
  "consistent with how neighboring watchers/listeners in the same class handle teardown."
  There is no such path and no such neighbor to be consistent with — plugging this would
  mean *inventing* a new `SessionManager.dispose()` lifecycle method (new public API
  surface) with no existing caller to invoke it. That's new behavior/structure, not
  structure-preserving cleanup, and exactly the kind of change the mandate said to stop and
  escalate on rather than take unilaterally.
- **Recommendation for conductor/architect:** either (a) leave as-is — not an active leak
  per the analysis above, or (b) if/when `SessionManager` grows a real dispose lifecycle
  (e.g. for hot-reload or multi-instance test isolation), fold this call in at that time.
  Not blocking merge.

### General CRAP/DRY pass over the feature diff
- Scope: `git diff --name-only 88669bc1 HEAD` (unchanged from cleaner's scope) —
  `bg-child-sessions.ts`, `pre-tool-use.ts` (Step-0 addition only), `spawn-child-session-options.ts`,
  `child-session-background-task-entry.ts`, the `SessionManager.ts` watcher/spawn block, all
  new/extended tests.
- `bg-child-sessions.ts` (24 lines), `spawn-child-session-options.ts` (62 lines),
  `child-session-background-task-entry.ts` (36 lines): single pure function each, already
  extracted for testability by the coder, well-documented, no duplication. No changes.
- `pre-tool-use.ts` Step-0 block (~28 added lines): one guard clause, one return. No changes.
- `SessionManager.ts` new surface (`onSpawnSession` wiring, `notifyParentOnChildComplete`,
  `getSessionLastErrorText`, `markOrphanedBackgroundTasks` guard): `notifyParentOnChildComplete`
  is the largest single new unit (~55 lines) but is linear/cohesive (gate → compute status →
  cap/truncate body → wrap → send → mirror registry) and already has dedicated tests for its
  edge cases (bg-child-result-04 double-notify guard, bg-child-result-05 truncation cap). No
  split warranted.
- Ran `jscpd --min-lines 10` across all changed files. 11 clones reported, all with both
  sides **outside** the feature's added line ranges (pre-existing duplication elsewhere in
  the 9000+ line `SessionManager.ts`, out of this feature's diff scope per the fork-merge
  guardrail). Zero duplication introduced by this feature.
- Mutation-site scan (count-only, per gate #3): skipped installing Stryker fresh for this
  pass — all new/changed files are small (24–62 line new files; ~28 and ~200 line diffs in
  larger files) and well under any plausible 100-mutation-site split threshold by inspection
  (few branches, mostly straight-line pure functions and one guard clause). Flagging this
  shortcut explicitly per the token-diet gate rather than silently skipping it — if the
  hardener's mutation run surfaces a >100-site file in this diff, that's new information,
  not something this pass missed.
- **Verdict: no code changes made this pass.** Feature diff is already at the CRAP/DRY bar;
  the one flagged item (listener field) is escalated above, not fixed.

### Gates (this session, before AND after — no changes made, so identical)
- `(cd packages/shared && bun run tsc --noEmit)` → 0 errors.
- `(cd packages/server-core && bun run typecheck)` → 0 errors.
- `(cd packages/shared && bun test src/agent/core)` → 125 pass / 0 fail / 256 expect().
- `(cd packages/server-core && bun test src/sessions)` → 107 pass / 0 fail / 218 expect().

## Open questions
- **For conductor/architect:** disposition of `unsubscribeChildCompletionWatcher` — escalated
  above, needs a decision (leave as-is vs. design a `SessionManager` dispose lifecycle).
  Non-blocking for merge either way.
