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
- **Conductor decision (this session):** leave `unsubscribeChildCompletionWatcher` as-is,
  non-blocking. Not touched.

## Hardener pass (this session) — mutation hardening

### Tooling
- Procured **Stryker** (`@stryker-mutator/core@9.6.1`) as a devDependency in both
  `packages/shared` and `packages/server-core` (well within the 15-minute timebox — no
  fallback to manual mutation needed).
- **Bun-monorepo caveat (document for future hardener runs):** a Stryker sandbox rooted
  *inside* `packages/server-core` cannot resolve `@craft-agent/shared/*` subpath imports —
  bun's `hoisted` linker only symlinks workspace packages into the **repo-root**
  `node_modules`, not into each package's own `node_modules`. Fix: run Stryker from the
  **repo root** (`./node_modules/.bin/stryker run`) with `mutate` globs pointing at
  `packages/server-core/src/...` paths and `commandRunner.command` doing `cd
  packages/server-core && bun test ...`. `packages/shared` itself has no such cross-package
  imports in the mutated files, so its sandbox worked fine from within the package.
  Config files were scratch (not committed) — recreate from this note if resuming:
  `mutate: ["packages/server-core/src/sessions/SessionManager.ts:6566-6629", ...]` (Stryker
  supports `file:startLine-endLine` range syntax, used throughout to stay inside the
  feature's added ranges per the mutation-scope mandate).

### Real gap found: the Step-0 gate's own test suite never runs
`pre-tool-use-checks.isolated.ts` (1332 lines) is the dedicated test suite for
`runPreToolUseChecks()`, including the bg-child-routing-02 gate matrix. Its `.isolated.ts`
naming (a pre-existing, repo-wide convention — 5 files total, this one dates to v0.5.0, long
before this feature) deliberately excludes it from bun's default `*.test.ts` discovery,
because it uses module-level `mock.module()` overrides that would leak into other test files
if run in the same process. **Nothing else runs it either** — confirmed via `bun test
./path/to/file.isolated.ts` (explicit path) vs `bun test src/agent/core` (glob discovery):
125 pass either way from the glob command, but the isolated file standalone shows 4 failures
including the mutant I'd just introduced. Every "125 pass" gate cited in this feature's
checkpoint history (coder, cleaner, refactorer phases) was measured **without** this file's
79 tests ever executing. This is a repo-wide test-infra gap, not something introduced by this
feature — flagging for conductor/QA since it likely affects gate confidence on other features
too, not just this one.
- **Fix scoped to this feature only** (did not touch the isolated-file convention itself —
  out of mutation scope and risky to change repo-wide test discovery unilaterally): added
  `packages/shared/src/agent/core/__tests__/pre-tool-use-step0-routing.test.ts`, a properly
  bun-test-discovered file covering the same Step-0 scenarios. Works without the heavy mocking
  because Step-0 is the *first* check in the pipeline and returns before touching anything the
  isolated file's `mock.module()` calls stub out (mode-manager, permissions-config, fs, config
  validators, …). `bun test src/agent/core` went from 125 → 134 pass.

### Kill rates (production code mutated, existing + new tests as the kill mechanism)
| File / region | Killed / Total |
|---|---|
| `bg-child-sessions.ts` (whole file) | 10/10 |
| `pre-tool-use.ts:753-767` (Step-0 gate block) | 17/17 |
| `spawn-child-session-options.ts` (whole file) | 11/11 |
| `child-session-background-task-entry.ts` (whole file) | 4/4 |
| `SessionManager.ts` added regions (registry glue, `getSessionLastErrorText`,
  `notifyParentOnChildComplete`, `markOrphanedBackgroundTasks` guard) | 90/114 |

### Real gaps found & fixed (new tests / strengthened assertions)
- Deny reason was only asserted via `toContain('spawn_session')` — a mutated/truncated
  reason string could still pass. Added an exact full-string assertion.
- `buildSpawnedChildSessionOptions`: `llmConnection`, `thinkingLevel`, `labels`, `projectId`
  inheritance/override were never asserted (only `model`/`permissionMode`/`workingDirectory`/
  `enabledSourceSlugs` were) — `?? ` mutated to `&&` survived silently. Added inherit +
  override assertions for all four.
- `getSessionLastErrorText`: only ever exercised with a single-message array, so the
  scan-from-end direction and the `role === 'error'` filter were unverified — a `for`-loop
  direction mutant and an always-true role-check mutant both survived. Added tests with a
  stale error followed by a fresh one (must return the *last*), and a trailing non-error
  message with an earlier error (must skip forward to find it).
- The `status === 'completed'` branch selecting `evt.finalText` vs.
  `getSessionLastErrorText(...)` survived a "always take the failed branch" mutant because
  existing tests never gave a *completed* child a stale error message to be confused by.
  Added that case.
- Truncation cap: only checked "stays under 16KB" for an oversized body — the `>` vs `>=`
  boundary and `Math.max`/`Math.min` (which would silently truncate content to near-zero
  while still passing the "under 16KB" check) both survived. Added an exact-16KB-untruncated
  test, a 16KB+1-byte-truncated test (multi-byte UTF-8 content, since `Buffer.byteLength`
  ignores unrecognized encoding args in Bun — ASCII test strings couldn't have caught a
  `'utf8'` → `''` encoding-string mutant even if it weren't equivalent), and a
  content-not-gutted assertion (`> 16KB - 200 bytes`).
- `?.trim()` on the assembled body was never verified — added a leading/trailing-whitespace
  case.
- `markOrphanedBackgroundTasks`: added a case where an entry is already terminal (must stay
  untouched, not get re-orphaned), a `keepBackgroundTasksAlive=true` case (must no-op
  entirely), and an unknown-`sessionId` case (must no-op, not throw) — none had dedicated
  coverage before.

### Accepted residue (24 survivors, SessionManager.ts) — documented, not force-covered
All in `notifyParentOnChildComplete` / `markOrphanedBackgroundTasks`, all either (a) pure
logging arguments with no other consumer, or (b) defensive guards whose only observable
effect under an active mutant is an exception swallowed by the fire-and-forget
`.catch(sessionLog.error)` at the subscription site — indistinguishable from the correct
early-return through the `sendMessage`-spy test harness this suite uses (both produce zero
`sendMessage` calls; the difference only shows up in log output, which nothing in this suite
mocks/asserts on):
- `sessionLog.info`/`.warn` string and object-literal arguments (lines 6575, 6613, 6617,
  6962) — content is not a behavior contract.
- `targetBusy` (line 6612, all 4 sub-mutants) — computed only to feed the log line above;
  no other code path reads it.
- `orphaned` counter (6958) and its `> 0` log gate (6961, 5 sub-mutants + block) — same
  class, log-only.
- `if (!child || !child.parentSessionId || !child.notifyParentOnComplete) return` (6568,
  2 sub-mutants) and `if (!parent) { warn; return }` (6574, 2 sub-mutants) — both guard
  against session-map states that can't arise from `spawn_session`'s own wiring in normal
  operation (a child always has its parent registered before it can complete); forcing
  observability here would mean adding `sessionLog` mocking infrastructure for two guards
  that don't affect delivery correctness when they do trip — not worth the added test-infra
  fragility (the very fragility that caused the `.isolated.ts` gap above).
- `if (registryEntry) { ... }` (6625) — same class: registry entry is always present for a
  `spawn_session`-created child by construction (`onSpawnSession` sets it before the child
  can complete); the guard is defense-in-depth, not a reachable branch in current wiring.
- `Buffer.byteLength(str, 'utf8')` → `Buffer.byteLength(str, '')` (6589, 6593): verified by
  hand this is **equivalent** in Bun — `Buffer.byteLength` silently ignores unrecognized
  encoding arguments and always computes UTF-8 byte length regardless
  (`Buffer.byteLength('é'.repeat(3), '') === Buffer.byteLength('é'.repeat(3), 'utf8')`).

### Gherkin acceptance mutation (soft, manual — no TS/JS gherkin-mutator exists)
No repo test runner executes `specs/bg-child-sessions/*.feature` directly (no cucumber/step
definitions found) — the `.feature` files are specs; the `bun test` files with matching
scenario-ID names (`bg-child-routing-02`, `bg-child-result-01a/b`, `bg-child-visibility-01`,
…) are the executable acceptance layer. Per `swarm-mutation-hardening`, "there is no unclebob
Gherkin-mutator for TS" — did a manual walkthrough instead: for every scenario/Examples row
in `bg-child-routing.feature`, `bg-child-result-feedback.feature`, and
`bg-child-visibility.feature` (the three specs backed by this session's mutation scope),
traced each Given/When/Then to its assertion and confirmed the assertion is
value-specific (not just type/shape-checking) — the language-mutation pass above already
proves this rigorously for the routing matrix, spawn-options inheritance, and registry-entry
shape (100% kill rate = every example-row value is genuinely load-bearing). The one gap this
walkthrough surfaced independently — the deny-reason step ("names spawn_session") only being
checked by substring — is the same fix already listed above. `bg-child-keep-alive.feature`'s
scenarios 02/03 remain QA/E2E scope (per the coder's original deferral); scenario 04's
routing-side half and scenario 01's matrix are outside this session's file-scope (they live
in `claude-agent.ts`, not touched by this hardening pass).

### Gates (this session)
- `(cd packages/shared && bun run tsc --noEmit)` → 0 errors.
- `(cd packages/server-core && bun run typecheck)` → 0 errors.
- `(cd packages/shared && bun test src/agent/core)` → 134 pass / 0 fail (was 125 — +9 from
  the new step0-routing test file).
- `(cd packages/server-core && bun test src/sessions)` → 121 pass / 0 fail (was 107 — +14
  from strengthened result-feedback/visibility tests).

### Next
- Conductor: hardener pass complete. Next role: **QA** — deferred scope unchanged from
  earlier phases (bg-child-keepalive-02/03 integration scenarios, full E2E background-work
  flow). Also worth QA/conductor awareness: the repo-wide `.isolated.ts` test-discovery gap
  (4 other files: `prerequisite-manager.isolated.ts`,
  `apps/electron/src/main/__tests__/{notifications-routing,session-branch-rollback,
  sessions-annotations}.isolated.ts`) is unrelated to this feature and was left untouched,
  but any prior "all green" claim that implicitly relied on one of those files running is
  worth re-checking.
