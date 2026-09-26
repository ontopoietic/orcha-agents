# Orcha Agents — Fork von Craft Agents

Dieses Repository ist ein Fork von [lukilabs/craft-agents-oss](https://github.com/lukilabs/craft-agents-oss).

## Fork-Metadaten

| | |
|---|---|
| **Upstream** | `https://github.com/lukilabs/craft-agents-oss.git` |
| **Unser Remote** | `https://github.com/ontopoietic/orcha-agents.git` |
| **Zuletzt gemerged** | v0.13.5 |
| **Upstream-Stand** | v0.13.5 (aktuell) |
| **Aktiver Branch** | `main` |
| **Feature-Branch** | `feature/cross-session-recall` (Observer/Reflector/Recall — größter offener Block, → main, s. §6) |
| **Sentry** | Deaktiviert (main + renderer) — kein Reporting |
| **Auto-Update** | Deaktiviert (`publish`-Block auskommentiert, `FORK_AUTO_UPDATE_DISABLED`) — Upstream-Feed seit v0.12.0 `https://thecraftagents.com/electron/latest` |
| **Pages-Public-Publishing** | Default AUS (`isPagesSharingEnabled()` → `false`, s. §10) |

---

## Unsere Änderungen

### 1. ~~Ledger UI~~ — entfernt (2026-09-26)
Die Orcha-Sync-Ledger-UI (LedgerPanel in der Sidebar, LedgerDetailPage, `ledger`-Route/Navigator, `ledger-watcher.ts` + `ledger:*`-IPC, `ledger-activity.ts`-Typen, `ledgerWorkingDirAtom`) wurde komplett entfernt, weil der Orcha-Sync-Ledger (`.orcha-ledger.json` / `.orcha-sync-history.json`) abgeschafft ist. Damit entfallen alle zugehörigen Upstream-Berührungspunkte (AppShell, SessionList, MainContentPanel, NavigationContext, nav-helpers, route-parser, routes, types, preload, main/index, channel-map-parity). Nummer bewusst beibehalten, damit §-Verweise im Update-Protokoll stabil bleiben. **Nicht betroffen:** der Markdown-Observation-Ledger des Memory-Systems (§6, `mastra-om/parse-ledger.ts` u. a.).

### 2. PreCompact Hooks
Ermöglicht Shell-Kommandos vor dem Context-Compaction-Event des Agents. Output wird dem Agent als "reason" zurückgegeben.

**Berührt Upstream-Dateien (Konflikt-Kandidaten):**
- `packages/shared/src/automations/automation-system.ts` — `+buildSdkHooks()`, PreCompact-Handler
- `packages/shared/src/automations/types.ts` — `+PreCompact` als `AgentEvent`
- `packages/shared/src/automations/schemas.ts` — Schema-Erweiterung für PreCompact
- `packages/shared/src/automations/automation-system.test.ts` — Tests für PreCompact
- `packages/shared/src/automations/name-utils.ts` — Hilfsfunktionen

**`command` vs. `script` (seit v0.13.5-Merge):** Upstream v0.13.0 führte eigene `script`-Actions ein (workspace-relatives Skript via argv, kein Shell, nur `CRAFT_*`-Env, u. a. für Pages-Refresh) und machte `ActionDefinitionSchema` zu einer **strikten** `discriminatedUnion` (unbekannte Action-Typen = Validierungsfehler, früheres `.passthrough()` entfernt). Unsere `command`-Action (Shell-Kommando, nur Agent-Events, stdout → Hook-`reason`) ist als `CommandActionSchema.strict()` in die Union aufgenommen, `AutomationAction = Prompt | Webhook | Script | Command`; `name-utils.ts` kennt beide. **Folgeaufgabe (offen):** prüfen, ob die PreCompact-Hooks auf `script` migrierbar sind (script läuft ohne Shell und ohne vollen `process.env`, liefert aber keinen Hook-`reason` an den Agent → vermutlich nicht 1:1).

**Hinweis (korrigiert 2026-08-06):** Die PreCompact-Registrierung liegt NICHT in `apps/electron/src/main/index.ts`, sondern im generischen Automation-Hook-System (`packages/shared/src/automations/{types,event-bus,sdk-bridge}.ts` + `buildSdkHooks()` in `automation-system.ts`).

### 3. App-Isolation (appId-Trennung)
**Problem:** Fork und Original-App nutzten dieselbe `appId` (`com.lukilabs.craft-agent`), wodurch sie sich **alle Daten teilten** (Workspaces, Credentials, Preferences, Drafts, Caches).

**Lösung (umgesetzt):**

1. **Neue `appId`**: `com.ontopoietic.orcha-agents` in `electron-builder.yml`
2. **Eigener Daten-Pfad**: `~/.orcha-agents/` statt `~/.craft-agent/` via `CRAFT_CONFIG_DIR` Env-Var
3. **Eigener Electron-UserData**: `~/.orcha-agents/electron-data/`

**Berührt Upstream-Dateien (Konflikt-Kandidaten):**
- `apps/electron/electron-builder.yml` — `appId` geändert
- `apps/electron/src/main/index.ts` — `CRAFT_CONFIG_DIR` auf `~/.orcha-agents` gesetzt, `userData` auf `~/.orcha-agents/electron-data/`
- `packages/shared/src/config/paths.ts` — **unverändert** — nutzt bereits `process.env.CRAFT_CONFIG_DIR` als Override
- `apps/electron/src/main/auto-update.ts` — `FORK_AUTO_UPDATE_DISABLED` (Launch-Check übersprungen, kein Auto-Download/-Install); `electron-builder.yml` `publish`-Block auskommentiert (Upstream-Feed seit v0.12.0: `https://thecraftagents.com/electron/latest`)

**Workspace-Aufteilung:**

| App | Workspaces | Daten-Pfad |
|---|---|---|
| Orcha Agents (Fork) | Orcha, Collibri, Lukas Auer Coaching | `~/.orcha-agents/` |
| Craft Agents (Original) | Orcha Agents, Kurz am Bau | `~/.craft-agent/` |

### 4. Orcha Branding (i18n-Overlay)
**Problem:** Upstream v0.8.5 führte i18n ein — 1050+ Strings mit "Craft Agents" Referenzen.

**Lösung:** Orcha-spezifische Strings werden über die bestehenden i18n-Keys geliefert, aber die Locale-Files müssen "Craft Agents" → "Orcha Agents" ersetzen.

**Berührt Upstream-Dateien (Konflikt-Kandidaten):**
- `apps/electron/src/main/menu.ts` — App-Name in Menü (verwendet i18n)
- `apps/electron/src/renderer/components/AppMenu.tsx` — Quit-Text
- `apps/electron/src/renderer/components/app-shell/TopBar.tsx` — Quit-Text
- `apps/electron/src/renderer/components/onboarding/WelcomeStep.tsx` — Welcome-Text
- `apps/electron/src/renderer/components/onboarding/ProviderSelectStep.tsx` — Title/Description
- `apps/electron/src/renderer/components/onboarding/ReauthScreen.tsx` — Reauth-Text
- `apps/electron/src/renderer/pages/settings/AppSettingsPage.tsx` — Updates-Section (manuell verwaltet)
- `apps/electron/package.json` — Name, Description, Version

**i18n Locale-Files (noch anzupassen):**
- Upstream hat Locale-Files in `apps/electron/src/i18n/` (oder ähnlich) — diese enthalten noch "Craft Agents" Strings
- TODO: Locale-Files für Orcha anpassen

### 4. Dev-Build Runtime Patches
Der `electron:dist:dev:mac` Build kopiert standardmäßig nicht alle Runtime-Dependencies (Claude SDK, Interceptor, Bun) ins App-Bundle. Diese müssen nach dem Build manuell kopiert werden.

**Berührt Upstream-Dateien (Konflikt-Kandidaten):**
- `packages/shared/src/agent/backend/internal/runtime-resolver.ts` — `+CRAFT_BUN` Env-Var Fallback für Dev-Mode ( Bun-Pfad )

**Manuelle Post-Build-Schritte (nicht in Git):**

Stand v0.10.4: `electron:dist:dev:mac` staged inzwischen `claude-agent-sdk` (Kern), `bun` und den Embedder **selbst**. Manuell nachzukopieren bleiben (`<app>` = `.../Orcha Agents.app`):

> **v0.11.0-Layout-Änderung:** Das App-Bundle hat kein `packages/`-Verzeichnis mehr — es bündelt `apps/electron` direkt (`dist/`, `src/`, `vendor/`, `node_modules/`). **Schritt 1 (TS-Sources kopieren) ist damit obsolet:** Observer-Skripte liegen als vorkompilierte `dist/observer-scripts/*.cjs`, pi-agent-server + session-mcp-server als gebündelte `dist/resources/*/index.js`. Es bleiben nur Schritte 2–4 (Binary/ripgrep/Quarantäne). Embedder kommt via `extraResources`-Merge nach `node_modules/@huggingface/transformers` (+ onnxruntime-node/-common), nicht mehr `vendor/embedder`.

```bash
APP="<app>/Contents/Resources/app"

# 1. (v0.11.0: ENTFÄLLT — Observer-Skripte sind vorkompiliert in dist/observer-scripts/*.cjs)

# 2. Natives Claude-Binary (~217 MB, SDK ≥ 0.2.113) — fehlt bei dev:mac, da NUR
#    build-dmg.sh es staged. Resolver sucht zuerst den Alias-Pfad.
#    Fehlt es → "Claude Agent SDK native binary not found. The app package may be corrupted."
ditto node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64 \
      "$APP/node_modules/@anthropic-ai/claude-agent-sdk-binary"
chmod +x "$APP/node_modules/@anthropic-ai/claude-agent-sdk-binary/claude"

# 3. ripgrep (aus @vscode/ripgrep seit SDK 0.2.113) — fehlt ebenfalls bei dev:mac
ditto node_modules/@vscode/ripgrep "$APP/node_modules/@vscode/ripgrep"
chmod +x "$APP/node_modules/@vscode/ripgrep/bin/rg"

# 4. Quarantäne entfernen (unsignierter Build), sonst blockiert Gatekeeper
xattr -dr com.apple.quarantine "<app>"
```

> **Sauberer wäre:** `electron:dist` (statt `:dev:mac`) inkl. `build-dmg.sh` nutzen — das staged SDK-Binary + ripgrep + Bun automatisch in den `claude-agent-sdk-binary`-Alias. Die manuellen Schritte oben sind der Workaround für schnelle Dev-Builds.

### 5. ZAI Models
Zusätzliche Modelle für den ZAI-Provider.

**Berührt Upstream-Dateien (Konflikt-Kandidaten):**
- `packages/server-core/src/model-fetchers/index.ts` — `+GLM-5.1`, `+GLM-5V-Turbo`
- `packages/shared/src/config/models-pi.ts` — ZAI-Modell-Konfiguration

### 6. Cross-Session Memory — Observer / Reflector / Recall (GRÖSSTER Block)

Eigenes Memory-System nach Mastras Modell (workspace-/resource-scoped Observations + bedeutungsbasiertes Recall), ein Monat Arbeit, ~57 neue + ~32 berührte Dateien. **Stark divergierend vom Upstream — der größte Rebase-Risikofaktor.** Architektur-Hintergrund: `sessions/260603-wide-sand/plans/HANDOFF-memory-architecture-pivot.md`.

Pipeline: **Observer** (Haiku, extrahiert pro Session Observations als Markdown-Ledger + Evidence-Sidecar) → **Auto-Anchor** (Haiku, taggt Observations mit Rahmen-Anchors feature/befund/anliegen) → **Reflector** (synthetisiert) → **Recall** (cross-session Retrieval-Tool + direktiver `<relevant_memory>`-Hint). Trigger feuern token-/count-basiert per Turn + Wake-on-Session-Open. Der frühere L3-**Episoden**-Layer ist komplett entfernt (Juni 2026); Cross-Session-Sicht für Menschen ist der Workspace-Scope-Toggle im Observations-Panel.

**Neue Module (kein Upstream-Konflikt) — `packages/shared/src/sessions/`:**
- `mastra-om/*` (Observer/Reflector-Prompts, Parser, anchored-bullet-Parsing)
- `observation-{loader,trigger,watermark,markdown-parser,format.md}` — Ledger lesen/schreiben + Token-Trigger
- `recall-engine.ts` — cross-session recall() + resolvePointer() + gatherRecallHint()/renderRecallHintBlock()
- `reflection-trigger.ts`, `auto-anchor.ts`, `auto-anchor-trigger.ts` — Reflector- + Auto-Anchor-Trigger
- `anchors.ts`

**Neue Skripte (detached, dev-mode) — `scripts/`:**
- `orcha-observe.ts`, `orcha-reflect.ts`, `orcha-recall.ts`, `orcha-recall-anchors.ts`, `orcha-migrate-observations.ts`, `lib/llm-extractor.ts`
- `lib/llm-extractor.ts` ist der EINZIGE LLM-Auth/Call-Pfad aller Skripte (OAuth → claude CLI, sonst API-Key). Der Legacy-Observer-Pfad (eigene Prompts, eigenes Auth-Plumbing, Pattern-Fallback, `ORCHA_OBSERVER_USE_MASTRA`-Switch) wurde Juni 2026 entfernt — `observations.md` ist seitdem read-only-Historie, geschrieben wird nur noch `observations.mastra.md`.
- Startup-Validierung: `validateOrchaScriptRuntime()` (`observer-runtime.ts`) prüft beim App-Start, dass alle vier spawnbaren Skripte auflösbar sind (paketiert: `dist/observer-scripts/*.cjs`); kaputte Builds zeigen einen Launch-Dialog statt still einzufrieren. Die Skriptliste (`ORCHA_SCRIPT_BASES`) ist Single Source of Truth für Build (`electron-build-main.ts`) und Spawn-Sites.

**Berührt Upstream-Dateien (Konflikt-Kandidaten):**
- `packages/shared/src/agent/core/prompt-builder.ts` — injiziert Observations + `<relevant_memory>`-Hint; feuert Observer/Reflector/Auto-Anchor-Trigger per Turn
- `packages/server-core/src/sessions/SessionManager.ts` — Observer-Wake on session-open
- `packages/shared/src/agent/session-self-management-bindings.ts` — bindet `recall` als Tool
- `packages/session-tools-core/src/{tool-defs,context,handlers/index,index}.ts` — `recall` als kanonisches Registry-Tool
- `packages/shared/src/agent/core/message-provider.ts`, `claude-agent.ts` — Streaming-Mode + Conversation-Tail
- `packages/shared/src/sessions/index.ts`, `protocol/dto.ts` — neue Exports/DTOs
- **UI:** `apps/electron/src/main/{index,observation-watcher}.ts`, `preload/bootstrap.ts`, `shared/{routes,route-parser,types}.ts`, `renderer/contexts/NavigationContext.tsx`, `renderer/components/anchors/SessionAnchorBar.tsx`, `renderer/components/app-shell/{AppShell,MainContentPanel,SessionList}.tsx`, `renderer/components/app-shell/input/FreeFormInput.tsx`, `renderer/hooks/useObservationStatus.ts` — Observations-Panel (Session-/Workspace-Scope), Anchor-Bar, Context-%-Anzeige

**Semantic Recall (Vektor-Schicht, Juni 2026):** Die Text-Achse von `recall()` nutzt Embedding-Similarity statt nur Token-Overlap. Lokaler Embedder via `@huggingface/transformers` (`Xenova/multilingual-e5-small`, 384 dim, on-device, kein API-Key); per-Session-Cache `data/observations-embeddings.json` neben dem Evidence-Sidecar. Neue Module: `sessions/{embedder,vector-sidecar}.ts`, `recallSemantic()` in `recall-engine.ts`, Backfill `scripts/orcha-embed-observations.ts`. Bewusst KEINE Vektor-DB (Mastras libSQL/F32_BLOB-Pfad): bei Observation-Skala (~10²–10³ Vektoren) reicht Brute-Force-Cosine, null neue native DB-Dependency. Degradiert ohne Embedder automatisch auf Token-Overlap (`ORCHA_EMBED_DISABLE=1`). Modell-Cache: `~/.orcha-agents/models` (dev + paketiert geteilt, offline nach erstem Download). **Packaging (macOS):** `build:copy` (`apps/electron/scripts/copy-assets.ts`) staged ein minimales Embedder-Runtime nach `vendor/embedder/node_modules` (transformers + jinja + onnxruntime-node/-common, sharp-Stub statt nativem libvips, ONNX auf darwin getrimmt, WASM/Maps gepruned → ~79 MB); `electron-builder.yml` `mac.extraResources` merged es nach `app/node_modules`, erreichbar von `dist/main.cjs`. Hardened-Runtime lädt die unsignierte `.node` dank `disable-library-validation` (bereits gesetzt). **Offen:** Win/Linux-Packaging (dort Fallback auf Text-Scoring) und Pi-Subprozess-Backend (Recall im Pi-Bun-Prozess braucht analoges Staging; in-process Claude-Pfad ist abgedeckt).

> **Verhältnis zum Orcha-Sync-Ledger:** Die Ledger-UI (§1) ist seit 2026-09-26 entfernt (Orcha sync-ledger abgeschafft). Der Observer übernimmt die konversationsbasierte Signal-Extraktion. Die Reflector-Bridge in den Orcha-CLI-Ledger (`orcha signal add-many`, Env `ORCHA_LEDGER_PROJECT_DIR` / `ORCHA_REFLECTOR_DISABLE_BRIDGE`) ist ebenfalls **entfernt 2026-09-26** — der Reflector schreibt nur noch in die Observation-Dateien der Session.

> **Verhältnis zum Upstream-Project-Memory (seit v0.11.0):** v0.11.0 führt ein *eigenes*, orthogonales Memory-Konzept ein — projekt-gebundenes `MEMORY.md` unter `{workspaceRoot}/projects/{slug}/`, agent-kuratiert (via Write/Edit, ~5000-Token-Cap), immer als `<project_context>`-Block via `system.ts` in gebundene Sessions gepusht. Kein Extraktions-Pipeline, kein Embedding. **Injection-Pfade kollidieren nicht:** unser §6-Kern `prompt-builder.ts` (`<session_memory>` + `<relevant_memory>`) ist upstream-unberührt; das Project-Memory sitzt in `system.ts` (statisch/cacheable). Beide koexistieren (Entscheidung beim v0.11.0-Merge: Option A). **Milde Redundanz, kein Korrektheitsproblem:** innerhalb *eines* Projekts subsumiert das kuratierte `MEMORY.md` (push) teilweise unseren anchor-gated Cross-Session-Recall (pull, nur Pointer). **Folgearbeit (bewusst offen):** Cross-Session-Recall projekt-scope-aware machen — same-project überlässt geteiltes Wissen dem `MEMORY.md`, Recall glänzt dann projektübergreifend, wo Upstream nichts abdeckt.

> **Keep-Alive/Streaming-Konflikt — GELÖST (Branch `swarm/bg-child-sessions`):** Der bis 2026-07-09 offene Konflikt zwischen WS2-Keep-Alive (`CRAFT_KEEP_BG_AGENTS_ALIVE`, persistente Query für überlebende Background-Subagents) und Streaming-Mode (`ORCHA_STREAMING_MODE`, frische Query pro Turn für Observation-Replacement) ist über **Child-Session-Routing** aufgelöst: Unter Streaming-Modus leitet ein zentraler PreToolUse-Interceptor (`packages/shared/src/agent/core/pre-tool-use.ts`, Schritt 0) jeden In-Query-Background-Spawn (`Agent`/`Task` mit `run_in_background=true`) per Deny+lenkender Begründung auf `spawn_session` um; das Ergebnis kommt über `SessionManager.notifyParentOnChildComplete` (Watcher auf `onSessionComplete`) als `<background_result>`-Nachricht zurück in den Parent-Turn. Damit hat die persistente Query nichts mehr am Leben zu halten — `claude-agent.ts::keepBackgroundTasksAlive` ist jetzt `resolveKeepBackgroundTasksAlive() && !isStreamingModeEnabled()` (Streaming gewinnt immer). Kill-Switch: `ORCHA_BG_CHILD_SESSIONS=0` stellt exaktes Upstream-Verhalten wieder her. **Neue Berührungspunkte für künftige Merges:** `pre-tool-use.ts` (neuer Schritt 0 vor der Permission-Mode-Prüfung), `SessionManager.ts` (`notifyParentOnComplete`-Feld auf `ManagedSession`, `notifyParentOnChildComplete`-Watcher, `RunningBackgroundTask.kind`), `base-agent.ts`/`spawn-session-tool.ts` (Cwd-Vererbung ergänzt), `system.ts` (neuer bedingter „Background Work"-Abschnitt). Pi-Backend-Parität ist bewusst nicht Teil dieses Commits (Pi hat kein Keep-Alive-Äquivalent; der Interceptor gilt dort über die geteilte `runPreToolUseChecks()`-Pipeline mit, was für Pi separat verifiziert werden sollte, bevor Pi eigene Background-Subagent-Patterns bekommt).

> **Neue Berührungspunkte seit v0.13.5-Merge:** (a) `claude-agent.ts` — Upstream-`PendingSteers` (`backend/claude/pending-steers.ts`) besitzt das Steering: `chatImpl` → `pendingSteers.runTurn(chatTurn(...))`, PreToolUse-Hook via `wrapHook`, das Steers an `hookSpecificOutput.additionalContext` anhängt. Unser PreToolUse-Resultat MUSS deshalb `checkResult.additionalContext` (p10/p11b-Reminder) selbst in `hookSpecificOutput` legen — der Wrapper merged dann. Kein eigenes `pendingSteerMessage` mehr. (b) System-Prompt wird mit `snapshot: true` einmal pro SDK-Session gepinnt — alles, was sich pro Turn ändert (Memory, Recall-Hint, Tail, Anchor-Reminder), gehört in `buildVolatileContextParts()`, nie in `getSystemPrompt()`. (c) `prompt-builder.ts` enthält jetzt Upstreams Git-Developer-Context (stable + volatile); unser §6-Block steht im volatile Builder direkt dahinter.

### 7. set_session_status: Selbst-Schließung erlaubt (bewusste Upstream-Abweichung, 2026-08-07)

Upstream (seit v0.11.0-Kanban) lehnt closed-Statusse („done"/„cancelled") im `set_session_status`-Tool pauschal ab („the human owns closure"). Im Fork dürfen Agenten ihre **eigene** Session schließen — Swarm-Rollen setzen sich nach abgeliefertem Handoff auf `done` (swarm-rollen-Konvention); erzwungenes „needs-review" ließ fertige Rollen-Sessions das Board zumüllen. **Fremd-Sessions bleiben geschützt** (Ablehnung wie Upstream).

**Berührt Upstream-Dateien (Konflikt-Kandidaten):**
- `packages/session-tools-core/src/handlers/set-session-status.ts` — Guard nur noch für `targetsOtherSession`
- `packages/session-tools-core/src/handlers/set-session-status.test.ts` — Self-Close-Fälle ergänzt
- `packages/session-tools-core/src/tool-defs.ts` — Tool-Beschreibung angepasst
- `packages/shared/src/prompts/system.ts` — „Setting status"-Absatz angepasst

### 8. create_task: Auto-Start + DAG-Nodes (bewusste Upstream-Abweichung, 2026-08-07)

Upstream-`create_task` (v0.11.2) legt Tasks nur ungestartet mit einem synthetischen Single-Node an. Fork-Erweiterung für Swarm-Ketten: `start: true` startet den Run direkt nach Anlage (User-Go für die Kette = Run-Freigabe), `nodes[]` erlaubt explizite DAG-Autorschaft (id/title/prompt/dependsOn/model je Node → Rollen-Kette mit Modell-Tiering). Der Start läuft über einen von `registerTasksHandlers` injizierten Hook durch **dieselbe** per-Workspace-TaskRunner-Registry wie `tasks:run` (agent-gestartete Runs bleiben per UI pausier-/stoppbar). Fail-soft: ohne Hook oder bei Run-Fehler wird der Task ungestartet angelegt + Warning.

**Berührt Upstream-Dateien (Konflikt-Kandidaten):**
- `packages/session-tools-core/src/context.ts` — `CreateTaskInput.start/nodes`, `CreateTaskResult.started/runId`
- `packages/session-tools-core/src/tool-defs.ts` — Schema + Beschreibung
- `packages/server-core/src/sessions/SessionManager.ts` — `setTaskRunHook` + `createTaskFn`-Erweiterung
- `packages/server-core/src/handlers/rpc/tasks.ts` — Hook-Installation in `registerTasksHandlers`
- `packages/server-core/src/handlers/session-manager-interface.ts` — `setTaskRunHook?` im Interface

**p12 — Orchestrator-Nesting (2026-08-09):** Agent-erstellte Tasks (create_task aus einer Session) setzen `parentSessionId` = aufrufende Session auf den Orchestrator (`createTaskFromSpec` +`opts.parentSessionId`) — die Task-Familie (Orchestrator + Node-Sessions) erscheint als Teilbaum unter dem Conductor (p9-Nesting) statt top-level. User-erstellte Tasks (Editor/RPC) bleiben parentlos. Kein `notifyParentOnComplete` (p11 besitzt die Zustellung — sonst Doppel-Notification). Ergänzend Skill-Regel: Conductor archiviert nach Settlement die **Node**-Session (nicht den Orchestrator = Board-Karte).

**p11 — Task-Run-Rückkanal (2026-08-09):** Agent-gestartete Runs melden ihr Settlement (Status + Verdict-Text des Orchestrators, 16-KB-Cap) als `<background_result task="task-run:<slug>">`-Nachricht in die aufrufende Session zurück — via `TaskRunner.waitUntilSettled` im Hook + `notifyParentOnTaskRunSettled()` (SessionManager), analog `notifyParentOnChildComplete` für spawn_session-Kinder. Ohne diesen Kanal hatte der Conductor keinen Wake-Pfad (Vorfall 2026-08-09: Run pass, Conductor wartete mit Monitor, Watch starb am Turn-Ende, Swarm stand).

### 9. bg-child-sessions p10: Hintergrund-Shells (2026-08-07)

Das SDK 0.3.220 (v0.11.3-Merge) drängt Modelle aktiv zu Bash `run_in_background` (Foreground-`sleep` blockiert, Monitor-Tool, Versprechen „re-invokes you when it exits") — unter Streaming-Mode stirbt die detachte Shell aber am Turn-Ende, still (Vorfall 2026-08-07: Hardener-Rolle detachte einen ~10-Min-Stryker-Run und beendete den Turn auf dieses Versprechen hin). Die p1–p9-Abdeckung galt nur Agent/Task/Workflow; p10 schließt die Shell-Lücke: Step-0-**Reminder** für Bash mit `run_in_background=true` (kein Deny — In-Turn-Hintergrund-Shells bleiben legitim) und Stop-Hook-Guard trackt jetzt auch `shell_backgrounded`/`shell_killed` im selben Set.

**Berührt Dateien:** `packages/shared/src/agent/core/pre-tool-use.ts` (Bash-Leg im defaultAsyncReminder), `core/stop-hook-guard.ts` (+Shell-Events, Reason-Text), Tests in `__tests__/{stop-hook-guard.test.ts,pre-tool-use-checks.isolated.ts}`.

**p11b — Monitor (2026-08-09):** Auch das Monitor-Tool (SDK 0.3.220) überlebt kein Turn-Ende — Watch stirbt mit dem Subprozess, ohne Event (kein `shell_backgrounded`-Analogon, daher nur Step-0-Reminder, kein Stop-Hook-Tracking). Reminder verweist auf den p11-`background_result`-Kanal als korrektes Muster.

### 10. Pages: Public-Publishing standardmäßig deaktiviert (v0.13.5-Merge, 2026-09-26)

Upstream v0.13.0 bringt **Pages** (agent-erstellte HTML-Mini-Dashboards, Sidebar-Navigator, Scheduled Refresh via `script`-Automations, Source-Grants). Lokale Pages bleiben im Fork voll aktiv. Das **öffentliche Teilen** (passwortgeschützte Public-Links) lädt das Page-Bundle aber auf Craft-Infrastruktur hoch (`DEFAULT_PAGES_SHARE_API_BASE_URL = https://thecraftagents.com/p/api`, Cloudflare-Worker) — Upstream-Default ist seit 2026-08-27 „an".

**Guard:** `packages/shared/src/feature-flags.ts::isPagesSharingEnabled()` liefert im Fork per Default `false` (Upstream: `true`). Wirkung: Share-Button in `PageView.tsx` ausgeblendet (außer eine Page ist bereits geteilt → nur Unpublish), `PagePublisher.publish/republish` werfen `PAGE_SHARING_DISABLED`, `pages:getShareCapabilities` meldet `sharingEnabled: false`. Unpublish bleibt immer möglich. Opt-in: `CRAFT_FEATURE_PAGES_SHARING=1` (optional `CRAFT_PAGES_SHARE_API_URL` auf einen eigenen Worker). Kein Agent-Tool publiziert (die Pages-Tools `list/get/create/update/write_page_data/delete_page` sind lokal).

**Berührt Upstream-Dateien (Konflikt-Kandidaten):**
- `packages/shared/src/feature-flags.ts` — Default von `isPagesSharingEnabled()` + `FEATURE_FLAGS.pagesSharing`-Doku

---

## Orcha CLI Änderungen

Diese Änderungen liegen im separaten Repository `~/Developer/orcha/` und sind **nicht Teil des Craft-Agents-Forks**.

### 5. Candidate-Klassifizierung (orcha/packages/cli)
**Problem:** Alle Kandidaten landeten als `"unknown"` — `appendSyncHistory()` las falsche Feldnamen (`category`/`type` statt `candidateType`).

**Berührt Dateien:**
- `packages/cli/src/lib/ledger.ts` — Zeile ~85, ~118: `c.category ?? c.type` → `c.candidateType ?? "unknown"`; Zeile ~394: `+rotateLedger()` Funktion
- `packages/cli/src/commands/sync.ts` — Zeile ~222: `createLedger()` ersetzt durch `rotateLedger(previousLedger, { commitHash, branch, maxSignals: 50 })`

### 6. Deutsche Konversations-Signale (orcha/packages/cli)
6 neue Regex-Patterns für deutsche Signal-Typen in Conversation-Extraktion:

| Pattern | Typ |
|---|---|
| `konzept-erkenntnis` | finding |
| `designprinzip` | preference |
| `lücke` | finding |
| `erweiterung` | task |
| `idee` | task |
| `modell` | assumption |

**Berührt Dateien:**
- `packages/cli/src/lib/candidates.ts` — Zeile ~119-124: 6 neue Pattern in `conversationSignalPatterns`

### 7. Ledger-Rotation (orcha/packages/cli)
**Problem:** Ledger wurde nach jedem Sync komplett gelöscht, was den Agent-Kontextverlust bedeutete.
**Lösung:** `rotateLedger()` behält die letzten N Signale (default 50), retains linked candidates, cleared obligations.

**Berührt Dateien:**
- `packages/cli/src/lib/ledger.ts` — `+rotateLedger(prev, opts)` Funktion
- `packages/cli/src/commands/sync.ts` — Verwendet `rotateLedger` statt `createLedger()`

---

## Update-Protokoll

| Datum | Von | Auf | Konflikte | Durchgeführt von |
|-------|-----|-----|-----------|------------------|
| Fork-Basis | — | v0.8.3 | — | Timo |
| 2026-04-10 | v0.8.3 | v0.8.3+fork | Keine (kein Upstream-Rebase) | Timo + Craft Agent |
| 2026-04-11 | v0.8.3+fork | v0.8.6 | 10 Konflikte (trivial: Branding+i18n Overlay) | Timo + Craft Agent |
| 2026-04-17 | v0.8.7 | v0.8.9 | 8 Konflikte (Branding, i18n locales, Local-Connection-Gruppe) | Timo + Craft Agent |
| 2026-05-06 | v0.8.9 | v0.9.1 | 12 Konflikte (channel-map-parity, Branding, i18n locales, electron-builder SDK-Pfad, runtime-resolver Refactor, pi-agent backendName, package.json Tiptap+ripgrep, FreeFormInput Local-Group). v0.9.0 Native-Binary SDK-Migration: build-dmg.sh erforderlich für SDK+ripgrep-Copy. Sentry-Import in InputErrorBoundary entfernt. Motivation: cold-session hydration fix `d5a31774` für UI-Freeze bei stale `api-error.json`. | Timo + Craft Agent |
| 2026-06-29 | v0.9.1 | v0.10.4 | **Merge statt Rebase** (124 Fork-Commits → Rebase unpraktikabel). 15 direkte Merge-Konflikte + 1 semantischer Auto-Merge-Fehler. Gelöst: package.json×3 (pi-Paket-Rename, Tiptap∪vaul, Version+Branding), index.html (CSP+Titel), main.tsx (Sentry bleibt aus, i18n-Bootstrap übernommen), AiSettingsPage (Manifest-Logik + Orcha-Label), **AppMenu/TopBar Upstream-Rewrite** (→ neue `app-menu/{Desktop,Mobile}AppMenu.tsx`, Symbol rebranded), auto-update (`autoUpdateLog` + Fork-Guard), main/index.ts (Data-Dir §3 + i18n-Hydration), ChatPage (compactTitleMenu + SessionAnchorBar), AppShell (Ledger/Observations-SessionList + FAB additiv), FreeFormInput (Local-Group jetzt in Upstream-Helper `groupConnectionsByProvider`), claude-agent (Streaming-Gate + resolvedCwd + sourceActivationDrain additiv). **Semantik-Fix:** prompt-builder Memory-Block (§6) musste von `buildStableContextParts()` → `buildVolatileContextParts()` verschoben werden (Issue-#862-Cache-Split). nav-helpers.ts (neu, exhaustive switch) brauchte ledger/observations-cases. **Upstream-Highlights:** LLM-Connections-Feature + storage-migrations, pi-SDK-Scope `@mariozechner` → `@earendil-works` 0.79.9, neue i18n-Lint-Gates. Validierung: typecheck:all ✓, shared 3120/0, electron+co 1045/10 (alle 10 Fehler **auch auf pristine v0.10.4** = vorbestehend), i18n parity+sorted ✓, electron:build ✓ (Embedder 79M + observer-scripts gestaged). | Timo + Craft Agent |
| 2026-07-02 | v0.10.4 | v0.10.5 | Trivial-Patch (Claude Sonnet 5 + SDK-Uplift 0.3.170→0.3.197). Nur 2 Konflikte: `apps/electron/package.json` (Version 0.10.5 + Orcha-Branding) und `bun.lock` (→ Upstream + `bun install`). Rest auto-gemergt (models.ts Sonnet 5, shared/package.json SDK-Peer 0.3.197, en.json). Validierung: typecheck:all ✓, shared 3125/0, i18n parity+sorted ✓. **Merke:** SDK-Uplift ändert das native `claude`-Binary → Post-Build-Copy (§4) mit neuem 0.3.197-Binary nötig. | Timo + Craft Agent |
| 2026-07-09 | v0.10.5 | v0.11.0 | **Merge** (`update/v0.11.0`, Backup `backup/main-v0.10.5`). Größtes Upstream-Release seit Fork-Basis: **Projects + Kanban-Board + durable Tasks/Conductor-DAG + Background-Agent-Keep-Alive** — wholesale übernommen (kein Ausblenden). **35 Konflikte**, davon: 3 Lockfile/package.json (→ Upstream-Version + Orcha-Branding + `bun install`), 7 i18n-Locales (Additiv-Union + Branding-Overlay, 21 Blöcke), 5 Tool-Registry/Bindings (`recall`/`set_session_anchors` ∪ `list_background_tasks`), 14 UI-Nav-Shell (Ledger/Observations-Routen ∪ Projects/Kanban-Routen, inkl. exhaustive-switch/Union-Types in `route-parser`/`routes`/`types`/`event-processor`), 2 Protokoll-DTO, 4 Backend. **Harte Dateien (Opus, manuell):** `SessionManager.ts` (Upstream +867/-37 TaskRunner/Conductor vs. Fork Anchor-Methoden — Method-Boundary-Union), `claude-agent.ts` (+272 persistent-input/keep-alive vs. Fork Streaming-Gate — **auto-gemergt, typecheck-verifiziert**), `pi-agent.ts`/`system.ts` (getSystemPrompt +`projectContext`-Param übernommen, Orcha-Branding bewahrt). **Semantik-Fix:** `set_session_status`-Beschreibung auf Upstream-„never-auto-close"-Semantik angeglichen (Kanban). **Upstream-Highlights:** Pi-SDK 0.80.3 (jiti-Uplift, s. Build-Gotcha unten), projekt-gebundenes `MEMORY.md` (§6-Reconciliation-Notiz), NSLocalNetworkUsageDescription-Fix. Validierung: typecheck:all ✓ (alle Pakete inkl. electron), shared **3198/0** (Quellbaum; `anchors.test.ts` + neue `projects/storage`-Tests grün), i18n parity+sorted ✓ (6 Locales, 1651 Keys), electron:build ✓ (Embedder 79M + observer-scripts `orcha-observe/reflect/recall-anchors` gestaged). | Timo + Craft Agent |
| 2026-07-11 | v0.11.0+fork | v0.11.1 | Trivial-Patch (GPT-5.6 Luna/Terra/Sol, natives Max-Thinking, Pi-SDK 0.80.6 mit Input-Token-Pricing-Tiers). Nur 2 Konflikte: `apps/electron/package.json` (Version 0.11.1 + Orcha-Branding) und `bun.lock` (→ Upstream + `bun install`). Root-`package.json` auto-gemergt (unser isolated-Runner-Fix + Upstream-Versionsbump koexistieren). **jiti-Gotcha erneut zugeschlagen** (Pi-SDK-Bump → nested jiti fehlte) — per dokumentiertem `bun install --force` behoben. Validierung: typecheck:all ✓, shared 3228/0, i18n parity+sorted ✓. | Timo + Craft Agent |
| 2026-08-06 | v0.11.1+fork (inkl. bg-child-sessions p1–p9) | v0.11.4 | **Merge** (`update/v0.11.4`, Backup `backup/main-v0.11.1+p9`). Nur **5 echte Konflikte**: `apps/electron/package.json` (Version+Branding), `bun.lock` (→ Upstream + `bun install`, kein jiti-Problem), `App.tsx` (2 Hunks: child-session-Chips ∪ Upstream startTime/Dismiss), `TaskActionMenu.tsx` (2 Hunks: Pill-Navigation ∪ Dismiss — Union), `SessionManager.ts` (Import-Union: spawn-child-session-Module ∪ `validateArchiveTarget`). **Semantik-Fang:** Upstream extrahierte das Turn-End-Orphaning in den neuen Helper `markLiveBackgroundTasksOrphaned` (`background-task-chip-state.ts`) — die p8.1-Child-Session-Exemption wäre dabei stillschweigend verloren gegangen; Exemption in den Helper verlegt. **Fork-Test-Drift gefixt (nicht merge-verursacht):** `persistent-input.test.ts` erwartete Keep-Alive-ON bei leerem Env — stale seit p6-Fold (`&& !isStreamingModeEnabled`, Streaming default ON); Tests auf p6-Semantik ausgerichtet. **Upstream-Highlights:** `create_task`- + `archive_session`-Tools (additiv neben `recall` registriert), Claude-SDK 0.3.197→**0.3.220** (⚠️ Post-Build §4 braucht neues natives Binary; Subagent-Nesting-Cap jetzt 1 — tangiert unser spawn_session-Routing NICHT), Opus 4.6 restauriert (`isDeprecatedClaudeOpus46Model` entfernt, One-Shot-Storage-Migration), Workspace-Transfer, Server-Lock-Exe-Verifikation, macOS-Auto-Update-Fix. Validierung: typecheck:all ✓, shared **3273/0** (+ `pre-tool-use-checks.isolated.ts` 79/0), i18n parity+sorted ✓ (6 Locales, 1655 Keys, keine neuen Branding-Strings), electron:build ✓ (Embedder 79M + 3 Observer-Skripte). Durchführung: Swarm (2× Sonnet-Rollen ui-chips/backend + Dirigent). | Timo + Craft Agent |
| 2026-09-26 | v0.11.4+fork | v0.11.4+fork | Keine (Fork-interner Rückbau). **Ledger-UI entfernt (Orcha sync-ledger abgeschafft)** — §1 gestrichen: 4 Dateien gelöscht (`ledger-watcher.ts`, `LedgerPanel.tsx`, `LedgerDetailPage.tsx`, `ledger-activity.ts`), Ledger-Hunks aus 13 Upstream-Dateien zurückgebaut → weniger Konfliktkandidaten beim nächsten Merge. Observation-Ledger (§6) unverändert. | Timo + Craft Agent |
| 2026-09-26 | v0.11.4+fork | v0.11.4+fork | Keine (Fork-interner Rückbau). **Reflector→Orcha-CLI-Ledger-Bridge entfernt** (`scripts/orcha-reflect.ts`: `findOrchaProjectDir`/`bridgeToOrchaLedger`, Env `ORCHA_LEDGER_PROJECT_DIR`/`ORCHA_REFLECTOR_DISABLE_BRIDGE`); Doku in `observation-watcher.ts`, `reflection-trigger.ts`, `SessionAnchorBar`-Tooltip und `skills/orcha-observer/SKILL.md` (schreibt jetzt nach `data/observations.mastra.md`) angepasst. Reflector-Kern unverändert. | Timo + Craft Agent |
| 2026-09-26 | v0.11.4+fork (inkl. Ledger-UI-/Reflector-Bridge-Rückbau) | v0.13.5 | **Merge** (`update/v0.13.5` von `chore/remove-ledger-ui`; `fix/sdk-0.3.258-fable-5-1` verworfen — durch Upstream überholt). **23 echte Konflikte** (Plan-Probelauf 27; `packages/{core,shared}/package.json` + `llm-connections.ts` auto-gemergt). Manifeste (6): root `package.json` (Upstream-Scripts inkl. docs-site/pages-worker ∪ Fork-`./`-isolated-Runner, `build` bleibt `electron:dist:mac` weil `scripts/build.ts` im OSS-Export fehlt), `apps/electron/package.json` (0.13.5 + Orcha-Branding + `build:observers`), `bun.lock` (→ Upstream + `bun install --force`), `tsconfig.base.json` (→ Upstream, das die Datei jetzt selbst mitliefert; ersetzt unseren Fix `f238100c`), `electron-builder.yml` (`publish` bleibt auskommentiert, nur Kommentar-URL → `thecraftagents.com`), `builtin-sources.ts` (Upstream-Löschung übernommen, Docs-Source weg; ebenso der `craft-agents-docs`-MCP-Server in `claude-agent.ts`). Automations (4): `script` ∪ `command` (s. §2). UI (8): Observations ∪ Pages in `route-parser` (NavigatorType + Prefixe), `nav-helpers` (exhaustive switch), `NavigationContext`, `MainContentPanel`, `AppShell`; `main.tsx`/`main/index.ts` Sentry bleibt aus (ungenutzte Upstream-Redaction-Imports entfernt); `FreeFormInput`: persistentes Fork-Kontext-Badge auf Upstreams snapshot-basiertes `getContextDisplay` umgestellt (wahrheitsgetreue %, Compact nur bei `canCompact`). Agent-Kern (5): `claude-agent.ts` — Fork-`pendingSteerMessage` durch Upstream-**`PendingSteers`**-Queue ersetzt (Wrapper hängt Steers an `additionalContext` an), Fork-p10/p11b-Reminder (`checkResult.additionalContext`) bei allow/modify weiter durchgereicht; Streaming-Gate, Stop-Hook-Guard p7, Context-Trace, Swarm-Hint auto-gemergt. `prompt-builder.ts` — Upstream-Git-Developer-Context (stable → `buildStableContextParts`, volatile → Tail) ∪ Fork-Memory/Recall-Hint/Conversation-Tail/Anchor-Reminder (volatile, nach dem Git-Block). `system.ts` (Upstream −641 Rewrite) — Upstream-Struktur + Orcha-Identität/Co-Author + `backgroundWorkSection` + Self-Close-Semantik (§7) in der neuen Session-Tools-Liste + `create_task start/nodes`-Hinweis; Docs-Zeile als „Fork von Craft Agents" markiert. `pi-agent.ts` — Upstream-Pinning (`pinnedIncludeCoAuthoredBy/ProjectContext`) + `'Orcha Agents Backend'`. `sessions/types.ts` — `AnchorRef` ∪ `ContextUsageSnapshot`. **Semantik-Checks:** `snapshot: true` (System-Prompt einmal pro SDK-Session gepinnt) ist unkritisch — Memory liegt in `buildVolatileContextParts()`, `backgroundWorkSection` env-konstant; `markLiveBackgroundTasksOrphaned`-Child-Session-Exemption, `notifyParentOnChildComplete`/`notifyParentOnTaskRunSettled`/`setTaskRunHook` intakt; Tool-Registry `recall`/`set_session_anchors`/`spawn_session`/`create_task`(start/nodes)/`set_session_status`(Self-Close) ∪ 6 Pages-Tools; Channel-Map-Parity ✓. **Merge-verursachter Fix:** Lockfile-Neuauflösung zog `@tiptap/extension-list` & 22 weitere StarterKit-Transitive auf 3.31.3, während der Fork `@tiptap/core` auf 3.22.3 pinnt → `getPreviousBlockSibling`-Import bricht (Editor/`mention-menu.test`). Fix: Top-Level-`overrides` in root `package.json` pinnen alle StarterKit-Transitive auf 3.22.3. **Pages-Publishing:** Default aus (§10). **Upstream-Highlights:** neue Domain `thecraftagents.com`, Moonshot/Kimi K3, **Pages (Beta)**, Fable 5.1, Pi-Retries + Utility-Query-Deadlines, Git-Developer-Context, Steer-Queue, Context-Usage-Snapshots, **Opus 5.5 = Default**, Claude-SDK **0.3.280** (⚠️ §4-Post-Build braucht neues natives Binary), Pi-SDK 0.87.1, `validate:ci`/i18n-coverage repariert. Validierung (isoliertes `HOME`): typecheck:all ✓, i18n parity+sorted ✓ (6 Locales, 1765 Keys, keine neuen Branding-Strings), **`validate:ci` ✓ (erstmals grün)**, shared **3507/13** (alle 13 identisch auf pristine v0.13.5 mit isoliertem HOME), `pre-tool-use-checks.isolated.ts` 83/0, electron+server-core+session-tools-core **1401/11** (alle 11 identisch auf pristine v0.13.5), electron:build ✓ (Embedder 79M + 3 Observer-Skripte). | Timo + Craft Agent |

---

## Upstream-Update-Anleitung

> **Package Manager: `bun`, nicht `pnpm`.** Falls `bun` nicht im PATH ist: `export PATH="$HOME/.bun/bin:$PATH"`.
> **Merge statt Rebase.** Bei >100 Fork-Commits ist ein Rebase (replay jedes Commits) unpraktikabel — ein Merge des Versions-Tags löst alle Konflikte in einem Durchgang.

Bei einem neuen Upstream-Release:

```bash
# 1. Upstream-Änderungen holen (Remote ggf. einmalig hinzufügen)
git remote add upstream https://github.com/lukilabs/craft-agents-oss.git  # nur beim ersten Mal
git fetch upstream --tags

# 2. Konfliktkandidaten ermitteln: Schnittmenge aus "von uns geändert" × "upstream geändert"
git diff --name-only <letzter-merge-tag> main      > /tmp/ours.txt
git diff --name-only <letzter-merge-tag> vX.Y.Z    > /tmp/upstream.txt
comm -12 <(sort /tmp/ours.txt) <(sort /tmp/upstream.txt)   # = manuell zu prüfende Dateien

# 3. Sicherung + Arbeits-Branch, dann Merge (NICHT Rebase)
git branch backup/main-<alte-version> main
git checkout -b update/vX.Y.Z
git merge --no-commit --no-ff vX.Y.Z
# → Konflikte in den Berührungspunkten (s.o.) manuell lösen.
#   Lockfiles nicht von Hand mergen: `git checkout vX.Y.Z -- bun.lock package.json && bun install`.
#   ACHTUNG: textuell sauber auto-gemergte Dateien können semantisch brechen
#   (z.B. unser Code referenziert einen Param, den ein Upstream-Refactor verschoben hat)
#   → typecheck:all ist der eigentliche Konflikt-Detektor.

# 4. Build + Validierung verifizieren
bun install
bun run typecheck:all
bun run lint:i18n:parity && bun run lint:i18n:sorted   # Branding-Overlay-Gates (blockierend)
bun test packages/shared/                              # Memory/automations/anchors
bun run electron:build                                 # Embedder-Staging + observer-scripts

# 5. FORK.md aktualisieren (PFLICHT!) — Versionen, Update-Protokoll, neue/entfernte Berührungspunkte

# 6. Committen
git add -A && git commit   # Merge-Commit mit Konfliktlösung
```

> **Wichtig:** `FORK.md` ist Teil des Update-Prozesses. Nach jedem Rebase/Merge muss sie den aktuellen Stand widerspiegeln. Ohne aktuelle `FORK.md` ist der nächste Update-Aufwand schwerer einzuschätzen.

### Bekannte vorbestehende Upstream-Defekte (Stand v0.13.5)
Diese Fehler existieren **im reinen Upstream v0.13.5** (verifiziert per pristine Worktree, gleiche Bedingungen: isoliertes `HOME=$(mktemp -d)`) und sind NICHT durch unseren Fork/Merge verursacht — nicht im Rahmen eines Updates „fixen":
- ~~`lint:i18n:coverage` / `validate:ci` brechen (fehlendes `scripts/check-i18n-coverage.ts`)~~ — **seit v0.13.2 upstream repariert**, `validate:ci` läuft im Fork grün.
- `packages/shared` (`cd packages/shared && bun test`): **13 Fehler**, alle umgebungsbedingt durch das isolierte `HOME` (fehlende `~/.orcha-agents/config-defaults.json` → `loadConfigDefaults()` wirft) oder Upstream-Test-Drift: 5× `system prompt guidance`, 4× `includeCoAuthoredBy handling`, `PiAgent pre-tool labels guard`, `createBackend … Anthropic provider`, `ClaudeAgent model switching (setModel)`, `PromptBuilder volatile/stable context split` (Timing: `getDateTimeContext()` stempelt ISO-Millisekunden, zwei Aufrufe liegen durch den Git-Developer-Context > 1 ms auseinander). Vor dem Merge (v0.11.4-Basis) waren es 9 derselben Familie.
- `apps/electron` + `server-core` + `session-tools-core`: **11 Fehler** — 8× `BrowserPaneManager` (headless electron-Window-Tests), 2× `RPC_CHANNELS wire-format stability` (Upstream fügte `pages:getShareDataScan` hinzu, ohne die Test-Fixture zu aktualisieren: 355 statt 354), 1× `refreshConnectionRuntime … supportsImages`.
- `session-branch-rollback.isolated.ts` / `prerequisite-manager.isolated.ts` — s. Build-Gotcha zu `.isolated.ts`.

### Build-Gotchas (Stand v0.13.5)
- **`bun test packages/shared/` zieht stale Build-Artefakte rein:** Der Glob matcht auch `apps/electron/release/mac-arm64/Orcha Agents.app/.../packages/shared/` (git-ignored Build-Output eines früheren `electron:build`, mit altem pi-ai → `getProviders`/`jiti`-Fehler). **Fix:** Tests aus dem Quellbaum laufen — `cd packages/shared && bun test` (0 fail) statt Repo-Root-Glob.
- **Pi-SDK 0.80.3 nested `jiti@2.7.0`:** `@earendil-works/pi-coding-agent@0.80.3` braucht `jiti@2.7.0` (für den `jiti/static`-Subpath; top-level 2.6.1 hat ihn nicht). Ein *inkrementeller* `bun install` über einen alten Hoist platziert die nested `pi-coding-agent/node_modules/jiti` nicht → `electron:build` bricht bei „Building Pi Agent Server" mit `Could not resolve: "jiti/static"`. **Fix:** `bun install --force` (platziert nested Copy per Lockfile). Kein Merge-/Lockfile-Defekt — die Lockfile kennt den nested Eintrag korrekt (identisch zu pristine v0.11.0).
- **Vorsicht bei Exit-Codes durch Pipes:** `bun run electron:build 2>&1 | tail` liefert den Exit-Code von `tail` (0), nicht des Builds. Immer `> log 2>&1; echo $?` verwenden.
- **`.isolated.ts`-Tests: Konvention absichtlich, Upstream-Runner kaputt (im Fork gefixt 2026-07-11):** Die 5 Dateien nutzen `mock.module(...)` (Module-Mocks leaken in bun prozessweit) → Naming nimmt sie aus der Discovery, der Root-`test`-Script soll sie einzeln in eigenen Prozessen ausführen. **Upstream-Bug:** `find packages/ …` liefert Pfade ohne `./`, `bun test <pfad-ohne-./>` interpretiert das als *Filter* → führt NICHTS aus und exitet 1. Die Dateien liefen also nirgends, je. **Fork-Fix:** `./`-Präfixe im find (root `package.json`). **Freigelegter Bit-Rot (vorbestehend, auf pristine v0.11.0 verifiziert):** `session-branch-rollback.isolated.ts` (0/1) und `prerequisite-manager.isolated.ts` (fail) schlagen auch upstream fehl — nie gelaufen, nie gepflegt. Nicht im Rahmen von Updates „fixen"; Kandidat für Upstream-Issue. Unsere `pre-tool-use-checks.isolated.ts`: 79/0 grün. **Falle bleibt:** Paketlokale Gates (`cd packages/shared && bun test`) umgehen den Root-Runner — relevante `.isolated.ts` explizit mit `bun test ./<pfad>` (mit `./`!) mitlaufen lassen.
- **Tiptap-Pin vs. Lockfile-Neuauflösung (v0.13.5):** Der Fork pinnt `@tiptap/*` direkt auf `3.22.3` (seit v0.8.x, `da1d123c`), Upstream nutzt `^3.20.0`. Weil unsere Specs von der Upstream-Lockfile abweichen, löst `bun install` die **transitiven** StarterKit-Extensions (`^3.22.3`) neu auf die neueste 3.x auf (v0.13.5-Merge: 3.31.3) — die brauchen aber ein neueres `@tiptap/core` (`getPreviousBlockSibling`-Export fehlt in 3.22.3) → Editor-Bundle/`mention-menu.test.ts` bricht. **Fix:** Top-Level-`"overrides"` in root `package.json` pinnt alle StarterKit-Transitive auf 3.22.3. Bei einem künftigen Tiptap-Bump Pin + Overrides gemeinsam anheben (oder zurück auf Upstream-Specs gehen und beide entfernen). Check: `grep -o '"@tiptap/[a-z-]*@[0-9.]*' bun.lock | sort -u`.
- **`build:observers`-Script in `apps/electron/package.json`** referenziert noch das entfernte `scripts/orcha-episode-emit.ts` (Episoden-Rückbau Juni 2026). `electron:build` nutzt es nicht (Observer-Skripte kommen aus `electron-build-main.ts`/`ORCHA_SCRIPT_BASES`), nur `apps/electron`s eigenes `bun run build` würde daran scheitern. Vorbestehend, nicht merge-verursacht.
