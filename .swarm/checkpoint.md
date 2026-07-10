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

## Next
- Conductor: **feature is code-complete across all 4 phases.** Next role per swarm-role-coder
  convention: **cleaner** (six-pack) — no further coder phases remain for
  `bg-child-sessions`. Deferred QA scenarios (02/03 of this phase, plus the always-QA-owned
  end-to-end assertions from phases 1-3) should route to the specifier/QA role for the
  end-to-end suite, per each phase's "does not own" boundary.
- No known open coder-side loose ends across any of the 4 phases.

## Open questions
- None blocking.
