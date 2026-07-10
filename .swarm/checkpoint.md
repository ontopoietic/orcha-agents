# bg-child-sessions — checkpoint

## Done
- Phase 1 (Routing) — all 6 scenarios in `specs/bg-child-sessions/bg-child-routing.feature` implemented and unit-tested.
- Validated inherited WIP (commit d4538de5) for phase-1 files against the spec:
  - `packages/shared/src/agent/core/bg-child-sessions.ts` — `isBgChildSessionsFlagEnabled()`, default-ON, kill switch `=0`/`=false`. Correct as-is.
  - `packages/shared/src/agent/core/pre-tool-use.ts` — Step 0 PreToolUse deny gate: `isParentTaskTool(toolName) && run_in_background===true && isStreamingModeEnabled() && isBgChildSessionsFlagEnabled()` → block with reason naming `spawn_session`. Matches full gate matrix (bg-child-routing-02) and scenarios 05/06. Correct as-is.
  - `packages/shared/src/prompts/system.ts` — steering section shown only when streaming+flag both on. Correct as-is.
  - Existing WIP tests (`bg-child-sessions.test.ts`, `pre-tool-use-checks.isolated.ts`) already cover the full 6-row gate matrix, Agent==Task parity, deny-reason content, and the unrelated-tool passthrough. All 8 + 79 tests pass.
- Added (new, this session) for scenarios 03/04, which the WIP had only as inline hardcoded logic in `SessionManager.ts` (not unit-testable in isolation):
  - `packages/server-core/src/sessions/spawn-child-session-options.ts` — pure `buildSpawnedChildSessionOptions(request, parent)`: sets `parentSessionId` = parent id, `notifyParentOnComplete: true` unconditionally (bg-child-routing-03); inherits `model`/`permissionMode`/`workingDirectory`/`enabledSourceSlugs`/`llmConnection`/`thinkingLevel`/`labels`/`projectId` from parent when the request omits them (bg-child-routing-04).
  - `packages/server-core/src/sessions/spawn-child-session-options.test.ts` — 11 tests, covers both example rows (claude-sonnet-5/allow-all, claude-haiku-4-5/ask) plus override-wins-over-inherit.
  - `SessionManager.ts`'s `onSpawnSession` closure now calls this helper instead of the inline object literal it had in the WIP — behavior unchanged (byte-for-byte same field mapping), just extracted for testability. Did **not** touch the surrounding `backgroundTaskRegistry.set(...)` block (phase 2/3 watcher/registry) — left untouched per WIP-inheritance instructions.
- Scenario 01's end-to-end "child session appears in session list" aspect is explicitly out of scope for this phase (QA's job).

## Gates
- `cd packages/shared && bun run tsc --noEmit` → 0 errors.
- `cd packages/server-core && bun run typecheck` → 0 errors (touched this package too; scope note below).
- `bun test` on touched/added files:
  - `packages/shared/src/agent/core/__tests__/bg-child-sessions.test.ts` — 8 pass
  - `packages/shared/src/agent/core/__tests__/pre-tool-use-checks.isolated.ts` — 79 pass
  - `packages/server-core/src/sessions/spawn-child-session-options.test.ts` — 11 pass
  - Sanity re-run of neighboring server-core session tests (`create-managed-session.test.ts`, `background-task-surface.test.ts`) — 18 pass across 3 files, no regressions from the `SessionManager.ts` edit.

## Tried & rejected
- Considered leaving `SessionManager.ts` fully untouched and only reasoning about scenarios 03/04 by inspection. Rejected: the task definition-of-done requires these covered by unit tests, and the inline closure isn't testable without a full `SessionManager` instantiation. Extracted only the pure request→options mapping (not the registry/notify-delivery machinery), which stays inside "spawn extension" scope, not "watcher/registry" scope.
- Considered exporting `SpawnSessionRequest`/`PermissionMode` types via new barrel entries in `packages/shared`. Rejected in favor of a local structural-subset interface (`SpawnChildSessionRequest`) in the new file — avoids touching shared package exports for a server-core-local test seam. `PermissionMode`/`ThinkingLevel` were already available from `@craft-agent/shared/agent` (not `/protocol` — first import attempt errored with TS2305, fixed).

## Next
- Conductor: spawn coder · p2/4 (SessionManager watcher/registry — child-session lifecycle tracking, `notifyParentOnChildComplete` delivery) fresh from this branch tip. Phase-2-relevant WIP already sits in `SessionManager.ts` (search `ORCHA §bg-child-sessions`) and `packages/session-tools-core/src/context.ts` (`BackgroundTaskInfo.kind`) — untouched by this run, still unvalidated.
- Phase 3/4 (keep-alive resolution in `claude-agent.ts`, system-prompt already phase-1-done) also still WIP-only/unvalidated.

## Open questions
- None blocking. Note for the conductor: the `keepBackgroundTasksAlive` change in `claude-agent.ts` (`resolveKeepBackgroundTasksAlive() && !isStreamingModeEnabled()`) was left untouched as phase-4 scope even though it already typechecks and its own test (`keep-alive lifecycle matrix` in `bg-child-sessions.test.ts`) already passes — worth confirming with whoever owns phase 4 whether that means phase 4 is effectively already done too, or still needs independent validation against its own scenarios.

---

## Phase 2 (Result Feedback) — done

### Done
- All 6 scenarios in `specs/bg-child-sessions/bg-child-result-feedback.feature` implemented and unit-tested.
- Validated inherited WIP in `packages/server-core/src/sessions/SessionManager.ts` (search `ORCHA §bg-child-sessions` near line 6534 onward) against the spec — it was already largely correct:
  - `unsubscribeChildCompletionWatcher` — a class-field `onSessionComplete` listener, i.e. hooks the exact same `emitSessionComplete` seam (fired from `onProcessingStopped` only when the message queue is truly empty — the same completion point the Tasks Conductor/TaskRunner uses) that phase 1's checkpoint flagged as still-WIP. Correct as-is.
  - `notifyParentOnChildComplete(evt)` — gates on `child.parentSessionId && child.notifyParentOnComplete` (bg-child-result-01 condition), clears the marker **before** the async send (exactly-once, bg-child-result-04), maps `reason==='complete'→'completed'`, anything else→`'failed'`, picks body from `finalText`/`getSessionFinalText` on success or `getSessionLastErrorText` (scans messages for last `role:'error'`) on failure — never silently swallows a failed turn (bg-child-result-01's "last error text"). Wraps in the exact `<background_result task="..." childSessionId="..." status="...">` tag the task spec names. Delivers via `this.sendMessage(parentId, wrapped, undefined)` — the same primitive `send_agent_message`'s `sendAgentMessageFn` uses (line ~4400), so delivered/queued semantics (busy-parent capture via `parent.isProcessing` before the call) are inherited, not reimplemented. Correct as-is.
  - **Bug found and fixed**: the 16 KB cap (`BG_CHILD_RESULT_CAP_BYTES`) was applied to the *content* only; the truncation pointer (`"\n\n[Result truncated — read the full output in child session ...]"`) was appended **after** capping, so the delivered body could exceed 16 KB in total — violating bg-child-result-05's "body is at most 16 kilobytes" (which the scenario ties to the *same* body that also names the child session). Fixed: compute the pointer's byte length first, cap content to `16KB − pointerBytes`, then append — total body is now always `<= 16KB`.
  - Left the registry-mirroring block at the end of `notifyParentOnChildComplete` (`parent.backgroundTaskRegistry.get(evt.sessionId)` → sets `status`/`completedAt`) **untouched** — this implements bg-child-visibility-03 (phase 3 scope), not phase 2. Did not add/remove/test it; noted here so phase 3's coder knows it already exists inline in this function rather than needing to be added fresh.
- New test file `packages/server-core/src/sessions/bg-child-result-feedback.test.ts` (9 tests) — invokes the private `emitSessionComplete`/`sendMessage` via casts (same pattern as `background-task-surface.test.ts`), covers:
  - 01a/01b: completed → final assistant text, failed → last error text, exact wrapper shape.
  - 02/03: idle vs busy parent — asserts the notifier calls `sendMessage` in both cases and never itself touches `parent.isProcessing` (that stays exclusively `sendMessage`'s job; queue vs. immediate-turn semantics are `sendMessage`'s existing, separately-tested behavior).
  - 04: exactly-once — marker (`notifyParentOnComplete`) flips to `false` after first delivery; a second `emitSessionComplete` for the same child does not call `sendMessage` again.
  - 05: oversized (20 KB) final text → asserts the **total** delivered body (content + pointer) is `<= 16KB` and names the child session id (this is what caught the truncation-cap bug above).
  - 06: asserts delivery goes through the ordinary `sendMessage` entrypoint (no bypass) — the observation-ledger pipeline itself is generic infra already covered by `packages/shared/src/sessions/__tests__/observation-trigger.test.ts` and friends; not re-tested here to avoid duplicating out-of-phase-2 infra.
  - 2 extra guard tests: no parent → no notify; marker unset → no notify.

### Gates
- `cd packages/server-core && bun run typecheck` → 0 errors.
- `cd packages/shared && bun run tsc --noEmit` → 0 errors.
- `bun test src/sessions/bg-child-result-feedback.test.ts` → 9 pass, 23 expect() calls.
- `bun test src/sessions` (full sessions dir, sanity re-run) → 100 pass, 0 fail, 196 expect() calls, 17 files — no regressions from the truncation-cap fix or the new test file.

### Tried & rejected
- Considered testing via the full `onProcessingStopped` path (real turn completion) instead of calling the private `emitSessionComplete` directly. Rejected: `onProcessingStopped` pulls in browser-pane-manager teardown, queue processing, mini-agent auto-complete, persistence — none of which phase 2 owns or needs to exercise; casting straight to `emitSessionComplete` (the documented seam) keeps the test scoped to the watcher's actual contract, same spirit as `fireTaskCompleted` casting to `processEvent` in `background-task-surface.test.ts`.
- Considered leaving the 16 KB truncation bug unfixed and only asserting current (buggy) behavior. Rejected: `bg-child-result-05` explicitly requires the body **and** the pointer together to respect the cap; a test asserting the bug would just be documenting non-compliance with the phase's own definition of done.

### Next
- Conductor: spawn coder · p3/4 (registry/UI visibility — `specs/bg-child-sessions/bg-child-visibility.feature`). Note the phase-3 registry-mirroring code (`registryEntry.status`/`completedAt` on terminal delivery) already exists inline at the tail of `notifyParentOnChildComplete` in `SessionManager.ts` — phase 3 should validate/test it there rather than assume it needs to be written from scratch. `backgroundTaskRegistry.set(...)` for the initial `running` entry (in `onSpawnSession`, ~line 4238) and the chip UI are still fully untouched/unvalidated, per this phase's mandate.
- Phase 4 (keep-alive resolution in `claude-agent.ts`) still untouched — same open question as noted in the phase-1 section above.

### Open questions
- None blocking.

---

## Phase 3 (Registry/UI Visibility) — done

### Done
- All 4 scenarios in `specs/bg-child-sessions/bg-child-visibility.feature` implemented and unit-tested.
- **Bug found and fixed**: `markOrphanedBackgroundTasks` (SessionManager.ts, turn-end sweep) orphaned *every* `status:'running'` registry entry regardless of `kind`, including `kind:'child-session'` ones — violating bg-child-visibility-02 (a child session's own subprocess/turn lifecycle is independent of the parent's, so it must not be orphaned when the parent's turn ends). Fixed with a `info.kind !== 'child-session'` guard in the sweep loop.
- Validated the rest of the phase-3 surface, which was already correct as inherited WIP:
  - Spawn-site registration (`onSpawnSession` closure, ~line 4238): sets `{taskId: session.id, intent: request.name, startTime, status:'running', kind:'child-session'}`. `intent` *is* the label field — `BackgroundTaskInfo`/chip UI read `intent`, not a separate `label` (session-tools-core/src/context.ts:562). Extracted the literal into a new pure `buildChildSessionBackgroundTaskEntry(session, request, now)` in `packages/server-core/src/sessions/child-session-background-task-entry.ts` (same spirit as phase-1's `buildSpawnedChildSessionOptions`) purely so bg-child-visibility-01's shape assertions are unit-testable without instantiating a full agent — behavior unchanged.
  - Terminal-status mirroring (bg-child-visibility-03): already existed inline at the tail of `notifyParentOnChildComplete` (SessionManager.ts ~line 6621, flagged by phase 2's checkpoint) — validated with a new test, correct as-is.
  - Retention cleanup (bg-child-visibility-04): `evictStaleBackgroundTasks` doesn't discriminate by `kind` at all — terminal child-session entries are swept by the same 1h-old rule as everything else. Confirmed via `listBackgroundTasks` (lazy eviction on read). No changes needed.
- New test file `packages/server-core/src/sessions/bg-child-visibility.test.ts` (7 tests):
  - 01: table test over `buildChildSessionBackgroundTaskEntry` — both example rows (research-competitors, summarize-repo) — asserts taskId/intent/status/kind/startTime.
  - 02: `markOrphanedBackgroundTasks` called directly (same seam-casting pattern as other phase tests) — a `kind:'child-session'` running entry stays `running`/no `completedAt`; a `kind:'in-query'` running entry in the same registry still gets orphaned (guards against a blanket "never orphan anything" over-fix).
  - 02b: `listBackgroundTasks` after the sweep reports the child entry with `status:'running'`, no `orphaned` anywhere.
  - 03: fires `emitSessionComplete` (same seam phase 2's tests use) with a pre-registered `running` entry present — asserts the registry entry flips to a terminal status (`completed`/`failed`) with `completedAt` set.
  - 04: a terminal `child-session` entry with `completedAt` 2h in the past is evicted by `listBackgroundTasks`.
  - 04b: same but 5 min in the past — kept (guards against an off-by-everything "evict all terminal entries" mistake).

### Gates
- `cd packages/server-core && bun run typecheck` → 0 errors.
- `cd packages/shared && bun run tsc --noEmit` → 0 errors.
- `bun test src/sessions/bg-child-visibility.test.ts` → 7 pass, 22 expect() calls.
- `bun test src/sessions` (full sessions dir, regression sweep) → 107 pass, 0 fail, 218 expect() calls, 18 files — no regressions from the orphan-sweep fix or new files.

### Tried & rejected
- Considered testing bg-child-visibility-01 by driving the full `onSpawnSession` closure (real `createSession` + real agent wiring). Rejected: that closure only exists after `managed.agent` is lazily instantiated, which pulls in far more machinery than this phase owns (same reasoning phase 1 used for `buildSpawnedChildSessionOptions`) — extracted the pure entry-building literal instead, byte-for-byte same shape.
- Considered just documenting the orphan-sweep bug as an "open question" for QA to catch later instead of fixing it now. Rejected: the task's own definition-of-done explicitly calls out "check the orphan-sweep logic excludes kind 'child-session'" as this phase's job, and leaving a known bg-child-visibility-02 violation in place would make the phase's own tests either fail or (worse) pass by asserting the bug.

### Next
- Conductor: spawn coder · p4/4 (keep-alive resolution in `claude-agent.ts`). Per phase-1's open question (still unresolved): `resolveKeepBackgroundTasksAlive() && !isStreamingModeEnabled()` in `claude-agent.ts` already typechecks and its own test (`keep-alive lifecycle matrix` in `bg-child-sessions.test.ts`) already passes as inherited WIP — worth the phase-4 coder confirming independently against phase 4's own spec/scenarios rather than assuming done, same as phases 1-3 each had to validate their inherited WIP instead of trusting it blind.
- No known phase-3 loose ends. Chip UI itself needs no new code (per the fixed design decision) — `RunningBackgroundTask`/`BackgroundTaskInfo` shapes already carry everything ActiveTasksBar/list_background_tasks need; scenario 01's actual chip-rendering assertion is explicitly QA's job (E2E), not this phase's.

### Open questions
- None blocking.
