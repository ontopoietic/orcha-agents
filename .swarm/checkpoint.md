# bg-child-sessions — checkpoint

## p8 hidden-children (this session) — FEATURE ROUND, opt-in hidden child sessions

Goal: swarm/role child sessions live as PILLS in the parent chat instead of
cluttering the session list. Commit `5f9b20e2` on `swarm/p8-hidden-children`
(branch tip; includes p1–p7 = `f3244b59`).

### Done
- **Key discovery (saved a rewrite):** `meta.hidden` was NOT dead code — it's a
  fully-wired-but-never-set field. `AppShell.tsx`'s `workspaceSessionMetas`
  (line ~1425/1427, the actual source feeding `SessionList`, label/status
  counts, and `useSessionSearch`) already unconditionally filters `!s.hidden`,
  as does `NavigationContext.tsx:543` (auto-select/keyboard nav) and
  `KanbanBoardContainer.tsx:200,250` (board tasks). `CreateSessionOptions.hidden`
  → `storage.ts`/`SessionManager.createSession` → persisted session metadata
  was already end-to-end. So requirement #2 ("session list respects it") came
  for free once the flag is ever set to `true` — the actual gap was 100% on the
  spawn-time plumbing + the escape hatch + pill navigation.
- **Opt-in flag threaded end-to-end** (default `false`, NOT inherited from
  parent — a hidden session's own children are not implicitly hidden):
  - `packages/shared/src/agent/spawn-session-tool.ts` — new `hidden: z.boolean().optional()`
    input + updated tool description (mentions the pill/list tradeoff).
  - `packages/shared/src/agent/base-agent.ts` — `SpawnSessionRequest.hidden?: boolean`;
    `preExecuteSpawnSession` reads `input.hidden`.
  - `packages/server-core/src/sessions/spawn-child-session-options.ts` —
    `SpawnChildSessionRequest.hidden?: boolean`; `buildSpawnedChildSessionOptions`
    returns `hidden: request.hidden ?? false` (NOT `parent.hidden ?? ...` —
    intentionally not inherited, per design decision #1).
  - No DTO change needed — `CreateSessionOptions.hidden` already existed
    (`packages/shared/src/protocol/dto.ts:144`).
- **Escape hatch** — "Show hidden sessions" toggle in `AppShell.tsx`, in the
  same dropdown as the existing "Group" submenu (grouping-mode pattern),
  persisted via a new `storage.KEYS.showHiddenSessions` localStorage key
  (mirrors `sidebarVisible`'s persistence pattern, non-workspace-scoped, plain
  boolean — simpler than the per-view `viewFiltersMap` grouping-mode state
  since this is a single global boolean, not per-filter-view).
  - `workspaceSessionMetas`'s filter became `showHiddenSessions || !s.hidden`.
  - `useSessionSearch.ts` had a SECOND, redundant blanket `!item.hidden` filter
    on its `items` prop (line 395) that would have silently defeated the
    toggle (AppShell includes hidden sessions in `items` when the toggle is
    on, but this hook would strip them right back out). Removed it — the hook
    now trusts the caller's filtering, same as it already does for
    `isArchived` (filtered per-filter-kind inline, not as a blanket pre-step).
    Confirmed `useSessionSearch` has exactly one caller (`SessionList.tsx`), so
    this is safe.
  - Did NOT touch `NavigationContext.tsx:543` (auto-select/keyboard next-prev)
    or `KanbanBoardContainer.tsx` — those are out of the "session list" scope
    per the mandate; the toggle only affects what `SessionList` renders.
- **Pill navigation** — `TaskActionMenu.tsx` had a real gap: `kind:'child-session'`
  tasks fell through to the generic `'agent'` type with zero navigation
  wiring (only "View Output" / "Stop Task" existed). Added:
  - `atoms/sessions.ts`: `BackgroundTask.kind?: 'child-session'` (previously
    ONLY `type: 'agent'|'shell'|'workflow'` existed — `kind` from the p5
    `task_backgrounded` event was read for the workflow branch but never
    stored on the task object at all).
  - `App.tsx`'s `handleBackgroundTaskEvent`: now also stamps
    `kind: 'child-session'` onto the pushed task when `evt.kind === 'child-session'`.
  - `TaskActionMenu.tsx`: new "Open session" menu item (shown only when
    `task.kind === 'child-session'`) that calls `NavigationContext.navigateToSession(task.id)`
    (falls back to `navigate(routes.view.allSessions(task.id))` when no
    context, same pattern `BackgroundFinishedChip.tsx` already uses — `task.id`
    IS the child's real session id for this kind).
  - `BackgroundFinishedChip.tsx` (the terminal/finished pill) was NOT touched —
    it already navigates generically by `sessionId` for ANY completed
    background session via `backgroundFinishedAtom`, not gated by `kind`, so
    hidden children already worked there. Confirmed by reading the file, not
    just inferring.
- **i18n**: `sidebar.showHiddenSessions` and `chat.openSession` added to all 7
  locale files (`en/de/es/hu/ja/pl/zh-Hans`), alphabetically sorted, parity
  confirmed via `lint:i18n:parity`/`lint:i18n:sorted` (both pass).
- **Spec**: added scenarios `bg-child-visibility-05..08` to
  `specs/bg-child-sessions/bg-child-visibility.feature` (default-visible
  without hidden, absent-by-default with hidden:true, toggle reveals/hides,
  pill + direct-nav reachability). Gherkin only — no acceptance
  parser/runtime work was in scope for this round (conductor mandate said
  "add scenarios", not implement the pipeline).
- **Tests**: extended `spawn-child-session-options.test.ts` with 3 new cases
  (defaults to `false`, explicit `true` override, NOT inherited from a
  `parent.hidden: true` fixture).

### Gates (all green)
- `(cd packages/shared && bun run tsc --noEmit)` — 0 errors
- `(cd packages/server-core && bun run typecheck)` — 0 errors
- `(cd apps/electron && bun run typecheck)` — 0 errors
- `(cd packages/shared && bun test src/agent/core)` — 161 pass, 0 fail
- `(cd packages/server-core && bun test src/sessions)` — 130 pass, 0 fail (18 files;
  was 125 pass at p5 checkpoint, +5 including the 3 new hidden tests + growth
  from unrelated intervening work)
- `bun run lint:i18n:parity` — OK (6 non-EN locales, 1653 keys each)
- `bun run lint:i18n:sorted` — OK

### Tried & rejected
- Considered threading `hidden` through `NavigationContext.tsx`'s
  `filterSessionsByFilter` (auto-select/keyboard nav) and
  `KanbanBoardContainer.tsx`'s board-task filter too, gated on the same
  toggle. Rejected: the conductor's design decisions (#2) scope the toggle to
  "the session list", and auto-select explicitly comments "hidden sessions
  should never appear in navigation" — conflating that with a user-visible
  display toggle risked auto-selecting/keyboard-cycling into a hidden swarm
  helper session, which is a worse UX than the status quo. Left as a possible
  fast-follow if the user wants "show hidden" to be fully global rather than
  list-scoped.
- Considered inheriting `hidden` from `parent.hidden` in
  `buildSpawnedChildSessionOptions` (mirroring how `model`/`permissionMode`/etc.
  inherit). Rejected per explicit design decision #1 ("Default FALSE... Do NOT
  hide all children implicitly") — every spawn is opt-in independently.

### Open questions
- None blocking. One judgment call flagged above (toggle scoped to session
  list only, not kanban/auto-select) — flag to the user if they expect "Show
  hidden sessions" to also reveal them on the kanban board.

### Rebuild implications for the conductor
**This round TOUCHES RENDERER** (`apps/electron/src/renderer/`): `App.tsx`,
`atoms/sessions.ts`, `AppShell.tsx`, `TaskActionMenu.tsx`,
`hooks/useSessionSearch.ts`, `lib/local-storage.ts`. All are component/hook
logic changes (new state, new filter behavior, new menu item, new event
field), not pure type-widening like p5's renderer touch — **a renderer bundle
rebuild is required** before any live/packaged-app re-verification, in
addition to the usual main-process rebuild for the `packages/shared` and
`packages/server-core` changes (spawn tool schema, base-agent, SessionManager
call chain is unchanged but the options builder it calls into changed).

### Next
- Conductor: rebuild (main + renderer), then live-verify at minimum:
  (a) a plain `spawn_session` call with no `hidden` still shows in the list,
  (b) `spawn_session` with `hidden: true` is absent from the list by default
  but shows as a running pill and a finished pill, both clickable to the
  child's session, (c) the "Show hidden sessions" toggle in the session
  list's Group/display dropdown reveals it, (d) opening the hidden child via
  a direct link/route still renders normally. No further coder work known to
  be needed for this slice; ready for cleaner/hardener per the swarm
  six-pack, or straight to merge review if this is being run as a four-pack.

## p7 stop-guard (this session) — FIX ROUND, three items from a second field incident

Incident: user asked an agent to "run this with the swarm" (plain text — no
`[skill:...]` mention, so the prerequisite gate never fired). The agent
improvised with the **Workflow tool**, which is background-by-design (returns
a task id immediately). The turn ended ~10s later; under streaming (keep-alive
off, per p4/p6) subprocess teardown killed the workflow. p6's orphan sweep
honestly marked it `orphaned` — but the work silently died with zero useful
indicator, and Workflow is a third spawn path the Step-0 gate (`Agent`/`Task`
only) never covered.

### Done — Item 1: Stop-hook guard (structural catch-all)
- New pure module `packages/shared/src/agent/core/stop-hook-guard.ts`:
  - `buildStopHookGuardDecision({runningTaskCount, streamingModeEnabled,
    bgChildSessionsFlagEnabled, alreadyFiredThisTurn})` → `{block: false} |
    {block: true, reason}`. Blocks only when running tasks > 0 AND streaming
    ON AND flag ON AND not already fired this turn — one-shot by
    construction (a stubborn model's second Stop attempt always passes).
  - `applyTaskLifecycleEvent(ids, event)` — pure `Set` update mirroring what
    `claude-agent.ts`'s per-message event loop already observes: add on
    `task_backgrounded`, delete on `task_completed`, no-op otherwise.
- `claude-agent.ts`:
  - New private state: `runningInQueryTaskIds: Set<string>` and
    `stopHookGuardFiredThisTurn: boolean`, both reset at the top of
    `chatImpl` (turn start) — anything left over from a prior turn already
    died at that turn's teardown, so carrying it forward would misreport.
  - The `chatImpl` event loop (`for (const event of events)`, right after
    `eventAdapter.adapt(message)`) now calls
    `applyTaskLifecycleEvent(this.runningInQueryTaskIds, event)` on every
    event before the existing source-activation-drain handling.
    `task_backgrounded` in this agent's own `AgentEvent` stream is ALWAYS an
    in-query Agent/Task/Workflow task — `kind:'child-session'` backgrounding
    (spawn_session, p5) is emitted by `SessionManager` directly to the
    renderer via a separate DTO event and never flows through this loop, so
    no extra filtering was needed (confirmed: the core `AgentEvent` type for
    `task_backgrounded` only has `kind?: 'workflow'`, no `'child-session'` —
    TS caught this when I tried to filter it defensively).
  - New `Stop` hook added to `internalHooks` in the SDK hooks builder
    (sibling to the existing `SubagentStop` hook, same block that already
    merges additively with automation hooks via `mergedHooks` — untouched).
    Calls `buildStopHookGuardDecision` with a live snapshot
    (`isStreamingModeEnabled()`, `isBgChildSessionsFlagEnabled()`,
    `this.runningInQueryTaskIds.size`, `this.stopHookGuardFiredThisTurn`),
    sets the fired flag, and returns `{continue: false, decision: 'block',
    reason}` (same generic `SyncHookJSONOutput` shape PreToolUse blocks
    already use — confirmed in `sdk.d.ts`: `decision`/`reason`/`continue` are
    NOT scoped to `PreToolUseHookSpecificOutput`, they're on the shared
    output type, so the same block shape works for `Stop`).
  - Noted but NOT used: `StopHookInput.background_tasks` — the SDK itself
    exposes an in-flight background-work summary on every Stop hook call
    (shell/subagent/monitor/workflow types, richer than what we need). Went
    with the hand-rolled set instead, per the explicit spawn-prompt
    instruction (and it also keeps the guard tied exactly to the
    Agent/Task/Workflow tasks this incident is about, not e.g. background
    shells which have different survival semantics).

### Done — Item 2: Workflow joins the p6 default-async reminder
- `pre-tool-use.ts`, same Step-0-adjacent block that already builds
  `defaultAsyncReminder` for bare `Agent`/`Task` calls (p6): added an
  `isWorkflowTool = toolName === 'Workflow'` leg. The reminder now fires for
  `(isParentTaskTool(toolName) && !run_in_background) || isWorkflowTool`
  under streaming+flag, with Workflow-specific wording ("background-by-design
  ... does not survive turn end ... will be marked orphaned"). The
  `run_in_background===true` DENY path for Agent/Task is completely
  unchanged — Workflow is never denied, only reminded (it has no
  `run_in_background` input to check in the first place).

### Done — Item 3: proactive swarm-skill hint
- `prompt-builder.ts`: new `getSwarmSkillHint(userMessage: string): string |
  null` method, module-level `SWARM_ORCHESTRATION_PATTERN` (swarm / "role
  team" keyword, OR a role name — coder/qa/specifier/hardener/cleaner/
  refactorer/architect/conductor — paired with an orchestration verb —
  run/spawn/dispatch/launch/use/orchestrate — to avoid firing on every bare
  mention of "qa"). Gated on `existsSync(join(workspaceRootPath, 'skills',
  'swarm', 'SKILL.md'))` — mirrors the 3-tier skill-path pattern already used
  in `pre-tool-use.ts::resolveSkillPlugin` (workspace tier only, since the
  hint is specifically about *this* workspace's swarm skill).
  - **Deliberately NOT wired into `buildContextParts`/`buildVolatileContextParts`**
    (unlike the anchor reminder) — those builders never receive the raw user
    message text, and the CAUTION in the spawn prompt said touch only the new
    hint block, nothing around observations/recall. Instead wired directly
    into `claude-agent.ts`'s `buildTextPrompt` and `buildSDKUserMessage` (the
    two places that already have `text` in scope), pushed right after
    `contextParts`/before attachments. Zero changes to the anchor-reminder
    machinery or anything else in `buildContextParts`.

### Tried & rejected
- None — all three items landed on the first attempt, no dead ends worth
  recording.

### Tests
- `packages/shared/src/agent/core/__tests__/stop-hook-guard.test.ts` (new,
  11 tests): `buildStopHookGuardDecision` — blocks with running tasks under
  streaming+flag (plural + singular reason wording), allows the second
  attempt through (`alreadyFiredThisTurn`), never blocks with streaming off /
  flag off / zero running tasks. `applyTaskLifecycleEvent` — add on
  `task_backgrounded`, remove on `task_completed`, ignores unrelated event
  types, no-ops on a missing `taskId`, returns the same `Set` instance.
- `packages/shared/src/agent/core/__tests__/pre-tool-use-step0-routing.test.ts`
  (extended, +4 tests): Workflow reminder present under streaming+flag
  (checks for "background-by-design" and "does not survive turn end"),
  Workflow is always `allow` (never denied), reminder absent when streaming
  off or the kill switch is set.
- `packages/shared/src/agent/core/__tests__/prompt-builder-swarm-hint.test.ts`
  (new, 8 tests): constructs a real `PromptBuilder` against a `mkdtemp`
  workspace so `existsSync` exercises the real filesystem (not mocked) —
  hint present for "swarm" / "role team" / role-name+verb phrasing when
  `skills/swarm/SKILL.md` exists; null when the skill is missing (even
  though the text matches), null for a bare role-name mention with no
  orchestration verb, null for ordinary requests, null for an empty message.
- `specs/bg-child-sessions/bg-child-routing.feature` — new
  `bg-child-routing-07` scenario (Workflow gets the same steering reminder).
- `specs/bg-child-sessions/bg-child-keep-alive.feature` — new
  `bg-child-keepalive-06` (Stop hook blocks once, allows the second attempt)
  and `bg-child-keepalive-07` (never blocks outside its gate) scenarios.

### Gates (all green)
- `(cd packages/shared && bun run tsc --noEmit)` — 0 errors
- `(cd packages/server-core && bun run typecheck)` — 0 errors
- `(cd packages/shared && bun test src/agent/core)` — 161 pass, 0 fail (10 files)
- `(cd packages/shared && bun test ./src/agent/core/__tests__/pre-tool-use-checks.isolated.ts)` — 79 pass, 0 fail
- `(cd packages/server-core && bun test src/sessions)` — 127 pass, 0 fail (18 files)

### Files changed
- `packages/shared/src/agent/core/stop-hook-guard.ts` (new — pure decision +
  set-update logic)
- `packages/shared/src/agent/claude-agent.ts` — new private state, event-loop
  tracking call, new `Stop` hook in `internalHooks`, swarm-hint call sites in
  `buildTextPrompt`/`buildSDKUserMessage`
- `packages/shared/src/agent/core/pre-tool-use.ts` — Workflow leg on the
  `defaultAsyncReminder` computation
- `packages/shared/src/agent/core/prompt-builder.ts` — new
  `getSwarmSkillHint()` method + module-level pattern constants
- Tests: `stop-hook-guard.test.ts` (new), `pre-tool-use-step0-routing.test.ts`
  (extended), `prompt-builder-swarm-hint.test.ts` (new)
- Specs: `bg-child-routing.feature` (+1 scenario), `bg-child-keep-alive.feature`
  (+2 scenarios)

**Rebuild implications for the conductor:** `claude-agent.ts`,
`pre-tool-use.ts`, `prompt-builder.ts`, and the new `stop-hook-guard.ts` are
ALL `packages/shared` (prompt/agent-core, consumed by the main/subprocess
bundle) — **no renderer (`apps/electron/src/renderer/**`) files touched**, so
only a main-bundle rebuild is needed to ship this round; no renderer bundle
rebuild required.

### Open questions
- None.

### Next
- Conductor: rebuild the main bundle (shared package changed) and, if
  desired, re-verify live: (a) ask an agent to improvise a `Workflow` call
  under streaming — confirm the `additionalContext` reminder appears in the
  transcript; (b) force a scenario where an in-query task is still running
  when the model tries to end its turn — confirm the Stop hook blocks once
  with the expected reason and allows the second attempt; (c) send a
  workspace session (with a `skills/swarm/SKILL.md` present) a plain-text
  "run this with the swarm" message — confirm the hint block appears in the
  user-message tail and the agent reads the skill file before orchestrating.
  This was the only outstanding fix round scoped to this session
  (bg-child-sessions p7) — nothing else pending.

## p6 keepalive-drift (previous session) — FIX ROUND, two field-found defects

Production incident: streaming mode ON, an agent launched analysis subagents via
`Agent` WITHOUT `run_in_background` (WS2 makes subagents async-by-default — "Async
agent launched"). The turn ended; keep-alive is off under streaming (p4 fix), so
subprocess teardown killed them. The registry showed them 'running' for 3+ hours
(zombies); `TaskOutput`/`TaskStop` in later turns couldn't resolve the ids.

### Done — Defect 1 (root cause: flag drift)
- `claude-agent.ts` resolved `keepBackgroundTasksAlive` as
  `resolveKeepBackgroundTasksAlive() && !isStreamingModeEnabled()` (p4 change) while
  `SessionManager.ts:1248` read the plain `resolveKeepBackgroundTasksAlive()` — the two
  call sites drifted, so `markOrphanedBackgroundTasks` (SessionManager.ts:~6966)
  early-returned under streaming and dead tasks never flipped to `orphaned`.
- Fixed at the root: moved the `&& !isStreamingModeEnabled()` combination INTO
  `resolveKeepBackgroundTasksAlive()` itself
  (`packages/shared/src/agent/backend/claude/persistent-input.ts`). No import cycle —
  `message-provider.ts` (home of `isStreamingModeEnabled`) has no dependency back on
  `persistent-input.ts`. Gave `isStreamingModeEnabled()` an optional `env` param
  (default `process.env`) so the resolver can pass it through cleanly.
- `claude-agent.ts`'s `keepBackgroundTasksAlive` field now reads the resolver PURE
  (`resolveKeepBackgroundTasksAlive()`, no local recombination). `SessionManager.ts`
  inherits automatically — verified `markOrphanedBackgroundTasks` now fires under
  streaming and flips running non-child entries to `orphaned` (new test, see below).
- The `complete` event's `backgroundTasksAlive` field (SessionManager.ts ~4148/4206)
  now reports the effective (streaming-aware) value too — desirable, this is the
  renderer's keep-alive signal and it should match reality. No renderer code changed;
  the field's semantics just became honest. **No renderer rebuild dependency for this
  defect** (shared + server-core only).

### Done — Defect 2 (steering fix, not a hard deny)
- The Step-0 interceptor (`pre-tool-use.ts`) only denied Agent/Task calls with
  `run_in_background === true`; default-async calls passed through silently and died
  at turn end with no signal to the model.
- Did NOT extend the deny to all Agent calls — in-turn parallelism must stay usable.
- (a) `system.ts`'s "Background Work" section gets one more sentence (only rendered
  under streaming+flag, same gate as the existing section): in-query subagents don't
  survive turn end — drain with `TaskOutput` (block) before ending the turn, or use
  `spawn_session` for work that must survive.
- (b) `pre-tool-use.ts`: added a new Step-0-adjacent check — Agent/Task calls WITHOUT
  `run_in_background` under streaming+flag are ALLOWED but the pipeline now attaches an
  `additionalContext` one-liner reminding of exactly that. Implemented as a computed
  `defaultAsyncReminder` var, attached at both terminal `allow`/`modify` return points
  (per-call, not per-turn — no per-turn state was trivially available in this
  synchronous pipeline). `PreToolUseCheckResult`'s `allow`/`modify` variants gained an
  optional `additionalContext?: string` field. `claude-agent.ts`'s switch merges it with
  the existing `pendingSteerMessage` additionalContext (steer text first, blank-line
  joined) instead of the two racing to overwrite each other. **`pi-agent.ts` NOT
  touched** — its `pre_tool_use_response` IPC protocol has no additionalContext
  concept, and WS2 default-async is Claude-SDK-specific; out of scope for this p6
  round.

### Tried & rejected
- None — both fixes landed cleanly on the first attempt, no dead ends worth recording.

### Tests
- `packages/shared/src/agent/core/__tests__/bg-child-sessions.test.ts` — the
  keep-alive matrix's local `effectiveKeepAlive()` helper used to hand-roll the exact
  drift-prone expression (`resolveKeepBackgroundTasksAlive() && !isStreamingModeEnabled()`).
  Replaced with a direct call to `resolveKeepBackgroundTasksAlive()` so the test
  actually exercises the fixed resolver instead of re-asserting a copy of the bug.
  Matrix + bg-child-keepalive-04 guard still pass unchanged (9 tests).
- `packages/shared/src/agent/core/__tests__/pre-tool-use-step0-routing.test.ts` — new
  `describe('default-async steering reminder ...')` block: reminder present under
  streaming+flag for a bare `Agent` call; absent when streaming off; absent when the
  `ORCHA_BG_CHILD_SESSIONS` kill switch is set; absent (deny path unchanged) for
  `run_in_background:true`; absent for unrelated tools. 5 new tests, all pass.
- `packages/server-core/src/sessions/bg-child-visibility.test.ts` — new
  `describe('bg-child-sessions p6: markOrphanedBackgroundTasks resolves keep-alive
  honestly under streaming')` block. Unlike the existing tests in this file (which
  override the `keepBackgroundTasksAlive` field directly to isolate the sweep from
  construction), these two tests set `ORCHA_STREAMING_MODE`/`CRAFT_KEEP_BG_AGENTS_ALIVE`
  env vars BEFORE `new SessionManager()` so the real construction-time resolution path
  — the one that actually broke in production — is exercised end-to-end: (1) streaming
  ON with the keep-alive flag still set to `1` → in-query entry orphans, child-session
  entry stays running (exempt); (2) `ORCHA_STREAMING_MODE=0` → upstream suppression
  returns, nothing orphaned (regression guard). 2 new tests, both pass.
- `specs/bg-child-sessions/bg-child-keep-alive.feature` — added
  `bg-child-keepalive-05` scenario documenting the honest-orphaning behavior and the
  regression it guards against.

### Gates (all green)
- `(cd packages/shared && bun run tsc --noEmit)` — 0 errors
- `(cd packages/server-core && bun run typecheck)` — 0 errors
- `(cd packages/shared && bun test src/agent/core)` — 139 pass, 0 fail (8 files)
- `(cd packages/shared && bun test ./src/agent/core/__tests__/pre-tool-use-checks.isolated.ts)` — 79 pass, 0 fail
- `(cd packages/server-core && bun test src/sessions)` — 127 pass, 0 fail (18 files)

### Files changed
- `packages/shared/src/agent/backend/claude/persistent-input.ts` — resolver now folds
  in streaming mode (the fix)
- `packages/shared/src/agent/core/message-provider.ts` — `isStreamingModeEnabled` gained
  optional `env` param
- `packages/shared/src/agent/claude-agent.ts` — `keepBackgroundTasksAlive` reads
  resolver pure; PreToolUse switch merges steer + step-0 additionalContext
- `packages/shared/src/agent/core/pre-tool-use.ts` — new default-async reminder logic;
  `PreToolUseCheckResult` type gained `additionalContext?`
- `packages/shared/src/prompts/system.ts` — one more sentence in the "Background Work"
  section
- `packages/server-core/src/sessions/SessionManager.ts` — comment update only (behavior
  already inherited from the resolver fix)
- Tests: `bg-child-sessions.test.ts`, `pre-tool-use-step0-routing.test.ts`,
  `bg-child-visibility.test.ts` (all in-tree, extended not replaced)
- Spec: `specs/bg-child-sessions/bg-child-keep-alive.feature` (+1 scenario)

**Renderer/system-prompt implication for the conductor:** `system.ts` changed (prompt
text, not renderer) — conductor should rebuild `main.cjs`/subprocess bundle so the new
reminder sentence actually ships; no renderer (`apps/electron/src/renderer/**`) files
touched, so no renderer bundle rebuild is required for this round.

### Open questions
- None.

### Next
- Conductor: rebuild main bundle (shared + server-core + prompts changed), re-verify
  the p6 incident scenario live if desired (spawn a default-async Agent call under
  streaming, let the turn end, confirm the registry entry flips to `orphaned` and the
  additionalContext reminder appeared in the transcript). This was the only outstanding
  fix round scoped to this session (bg-child-sessions p6) — nothing else pending.

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

## QA pass (this session) — final independent verification

Full report: `specs/bg-child-sessions/qa-report.md`. Ran live against the packaged
Electron app (fork build at `180dff79`) via CDP UI-driving — no project API. Own
test sessions only, prefixed and disposable, in the real `my-workspace` workspace.

### Done
- **Priority 1 (bg-child-keepalive-02/-03) — PASS, both, with strong live evidence.**
  Testability gap found and worked around: the Mastra observer's token-trigger needs
  ~96KB raw transcript growth at its default threshold (bytes/4 heuristic) to fire —
  incompatible with a minimal-prompt QA budget. Relaunched the app with
  `ORCHA_OBSERVER_THRESHOLD_TOKENS=300` (a legitimate launch-env affordance, same class
  as `ORCHA_STREAMING_MODE`, unrelated to this feature's own code) to make the mechanism
  observable cheaply. `meta/context-trace.jsonl` then showed the exact expected
  signature: `replacement:true`, `sdkResume:false`, `inputTokens` dropping/plateauing
  (39609 → ~31000) instead of continuing its prior linear growth. Full keepalive-03 E2E
  chain (background prompt → child → turn ends → 2 more turns, context non-monotonic →
  exactly one `background_result` → observation ledger entry naming the task) all
  confirmed in one session (`260710-early-silver`).
- **Priority 2 (bg-child-routing-01) — PASS.** Forced the actual PreToolUse gate (agent
  explicitly told to call `Agent(run_in_background:true)`): denied with exact deny
  reason naming `spawn_session` → agent self-rerouted via `spawn_session` in the SAME
  turn → child created before turn end → turn ended normally → result delivered next
  turn. Note: left to its own judgment the model often calls `spawn_session` directly
  (bypassing the gate) since it's a first-class tool — both are intended behaviors, but
  only forced Agent/Task calls exercise the gate itself.
- **Priority 3 (bg-child-visibility-01/-03) — visibility-03 PASS; visibility-01
  PARTIAL/FAIL.** `list_background_tasks` introspection correctly reports
  `status:"running", kind:"child-session"` for genuinely running children — that half
  passes. **The running-state UI chip never renders** for `kind:'child-session'` tasks
  (confirmed via ~40s+ of live DOM polling across two separate running children) — only
  a terminal `BackgroundFinishedChip` shows, and only after completion.
- **Root cause found (not fixed):** `SessionManager.ts`'s `onSpawnSession` (~line 4223)
  registers into `backgroundTaskRegistry` (drives `list_background_tasks`) but never
  emits a `task_backgrounded` event (drives the renderer's `ActiveTasksBar`, the actual
  running-chip component — separate from the terminal-only `BackgroundFinishedChip`).
  `task_backgrounded` is only emitted for `Task`/`Agent`/`Workflow` tool calls via
  signature-scanning in `packages/shared/src/agent/tool-matching.ts`; `spawn_session`
  was never wired into that path. This directly contradicts
  `bg-child-visibility.feature` scenario 01's explicit running-chip requirement — a
  genuine gap against the accepted spec, not a flaky timing issue. Renderer files
  involved (`App.tsx`, `ActiveTasksBar.tsx`, `atoms/sessions.ts`) have zero commits on
  this branch — pre-existing generic code the feature never finished wiring into.
- **Not fixed this session** — minimal correct fix touches the shared DTO (`kind` union
  needs `'child-session'` added, currently `'workflow'`-only), `SessionManager.ts` (emit
  the event from `onSpawnSession`), and renderer state (`ActiveTasksBar` kind handling)
  — multi-file, needs an app rebuild to re-verify live. Not the single-site "minimal QA
  fix" the checkpoint-discipline gate scopes QA-owned fixes to. Escalating instead.
- Result-feedback, exactly-once delivery, truncation-with-pointer, and observation
  recording all independently reconfirmed as a side effect of the E2E runs above (PASS
  on bg-child-result-01/02/04/05/06). Context inheritance (model, permissionMode,
  enabledSourceSlugs, parentSessionId) confirmed by diffing parent/child
  `session.jsonl` headers (PASS on bg-child-routing-03/04).
- Remaining gate-matrix rows (routing-02 b/c/d, routing-06, keepalive-01/-04) NOT-RUN at
  UI level — each needs a full app relaunch with different launch env vars, not
  attempted given budget after the above. High confidence carried over from the
  hardener's unit/mutation coverage (100% kill rates on the relevant blocks).
  bg-child-result-01(failed)/QA-F-3 and QA-F-2 (busy-parent) also NOT-RUN — attempted
  the failed-child case but the child agent gracefully absorbed the induced error
  instead of hitting the SDK-level `"failed"` terminal status; busy-parent case never
  got a chance to fire since every background task in this pass completed in under a
  minute. bg-child-visibility-04 (1h+ retention) NOT-RUN, infeasible in-session.

### Open questions
- **For conductor/user (merge decision):** the running-chip gap (bg-child-visibility-01)
  is real and spec-contradicting, but scoped to visibility/polish — the task is fully
  and correctly tracked via `list_background_tasks` throughout its lifecycle; only the
  live visual indicator is missing (a retroactive "finished" chip does appear).
  Recommend either merging with this logged as a fast-follow, or routing back to
  coder/cleaner for the scoped fix (see root-cause notes above) before merge. Not a
  data-loss or correctness defect in the background-execution model itself.

### Next
- Conductor: QA pass complete, all priority items covered with live evidence. Full
  report at `specs/bg-child-sessions/qa-report.md`. Bring the merge question (see Open
  questions above) to the user, including the one confirmed defect and its scoped fix
  location, per swarm convention.

## p5 running-chip fix (this session) — FIX ROUND, single bug

Fixed the one QA-confirmed defect (bg-child-visibility-01): `onSpawnSession` registered
the child in `backgroundTaskRegistry` but never emitted `task_backgrounded`, so
`ActiveTasksBar` (driven by that event, not by the registry) never showed a running chip
for `kind:'child-session'` tasks.

### Done
- New file `packages/server-core/src/sessions/child-session-backgrounded-event.ts` — two
  pure builders, same extraction pattern as `child-session-background-task-entry.ts`:
  - `buildChildSessionBackgroundedEvent(parentSessionId, session, request)` → the
    `task_backgrounded` event (`kind:'child-session'`, `taskId` = child session id,
    synthetic `toolUseId: spawn_session:<childId>` since spawn_session has no matching
    transcript tool result to key off of).
  - `buildChildSessionCompletedEvent(parentSessionId, childSessionId, status)` → the
    `task_completed` event that clears the chip (matches by `taskId`).
- `SessionManager.ts`:
  - `onSpawnSession` (~line 4223): after `backgroundTaskRegistry.set(...)`, now also
    calls `this.sendEvent(buildChildSessionBackgroundedEvent(...), managed.workspace.id)`.
  - `notifyParentOnChildComplete` (~line 6620): after mirroring `registryEntry.status`,
    now also calls `this.sendEvent(buildChildSessionCompletedEvent(...), parent.workspace.id)`
    inside the existing `if (registryEntry)` guard.
- DTO/type changes (widened union only, no new branches needed anywhere):
  - `packages/shared/src/protocol/dto.ts`: `task_backgrounded`'s `kind?: 'workflow'` →
    `kind?: 'workflow' | 'child-session'`.
  - `apps/electron/src/renderer/event-processor/types.ts`: same widening on
    `TaskBackgroundedEvent.kind`.
- **Renderer components untouched** — verified `ActiveTasksBar.tsx`/`TaskActionMenu.tsx`
  are generic over `BackgroundTask` and don't branch on `kind`; `App.tsx`'s
  `handleBackgroundTaskEvent` only branches on `kind === 'workflow'` (for the fan-out
  counter), so `kind:'child-session'` falls through to `type:'agent'` and renders
  automatically once the event exists. Confirms the QA root-cause note ("multi-file fix
  needed") — turned out to be emission-only; renderer already handled the shape.
  `BackgroundTask.type` union was NOT extended (smallest diff — 'agent' badge label is
  fine; `intent` still carries the child name as the chip's display label).
- Tests: extended `packages/server-core/src/sessions/bg-child-visibility.test.ts` (not a
  new file — this is where bg-child-visibility-01/03 already lived):
  - 3 new pure-builder tests (event shape, intent-omitted case, taskId-matching case).
  - 1 new integration test asserting `notifyParentOnChildComplete` actually calls
    `sendEvent` with a `task_completed` whose `taskId`/`sessionId` match (spies on the
    private `sendEvent`, same cast pattern the file already uses for `sendMessage`).
  - Did NOT add an integration test for the `onSpawnSession` emission itself — reaching
    it requires a real `managed.agent` wiring (same reason the pre-existing
    `buildChildSessionBackgroundTaskEntry` test only covers the builder, not the call
    site); covered by the pure-builder test instead.

### Gates (all green)
- `(cd packages/server-core && bun run typecheck)` — 0 errors
- `(cd packages/shared && bun run tsc --noEmit)` — 0 errors
- `(cd apps/electron && bun run typecheck)` — 0 errors
- `(cd packages/server-core && bun test src/sessions)` — 125 pass, 0 fail (18 files)
- New tests specifically: `bun test src/sessions/bg-child-visibility.test.ts` — 14 pass, 0 fail

### Files changed (exactly these 5 — conductor needs to rebuild for re-verify)
- `packages/server-core/src/sessions/child-session-backgrounded-event.ts` (new)
- `packages/server-core/src/sessions/SessionManager.ts` (server-core — main process)
- `packages/server-core/src/sessions/bg-child-visibility.test.ts` (tests only)
- `packages/shared/src/protocol/dto.ts` (shared type)
- `apps/electron/src/renderer/event-processor/types.ts` (**renderer** — type-only change,
  no component logic touched)

**Renderer files DID change** (`apps/electron/src/renderer/event-processor/types.ts`), so
the conductor must rebuild both `main.cjs` (server-core/electron-main consumes the
SessionManager + shared changes) AND the renderer bundle before re-verifying live. The
renderer change is a type-union widening only — no `ActiveTasksBar`/`App.tsx`/component
logic was touched — but it's still renderer source, so skipping the renderer rebuild
would silently test stale bundle code.

### Open questions
- None. Single-bug fix round, scope held exactly to bg-child-visibility-01.

### Next
- Conductor: rebuild (main + renderer per above), re-run QA scenario
  bg-child-visibility-01 live (spawn a notify-on-complete child, confirm a running chip
  appears above the parent's input with the child's name, confirm it clears/goes terminal
  on completion). If it passes, this was the only outstanding defect from the QA report —
  ready for the merge decision.

## p5 verify (this session) — MINI-VERIFY, PASS

Mini-verify of exactly the p5 fix (commit `529d94a7`), per conductor mandate — not a
full QA re-run. Verified live against the packaged app (CDP `127.0.0.1:9333`), own
session `260710-tall-bay` (two children: `260710-calm-aspen`, `260710-quiet-coral`).

### Done
- bg-child-visibility-01: **PASS**. Polled DOM every 2s during a running child — running
  chip (`"Click for task actions"`, elapsed counter 2s→18s) visible above the input
  while running, flips to `"...done"` on completion, clears from DOM ~8s later. Full
  detail + evidence table in `specs/bg-child-sessions/qa-report.md` § "p5 verify".
- bg-child-visibility-03 regression: PASS, unaffected (separate `BackgroundFinishedChip`
  mechanism).
- Exactly-once `background_result`: PASS, 2 children → 2 results, no dupes/misses.

### Next
- No known open defects for bg-child-sessions. Ready for conductor's merge decision —
  no further QA work needed unless the user requests deferred/NOT-RUN scenarios
  (keepalive-01/-04, result-01-failed, result-03 busy-parent, visibility-04) be covered.

### Open questions
- None.
