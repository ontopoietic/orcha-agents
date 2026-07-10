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
