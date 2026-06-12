# Orcha Agents — Fork von Craft Agents

Dieses Repository ist ein Fork von [lukilabs/craft-agents-oss](https://github.com/lukilabs/craft-agents-oss).

## Fork-Metadaten

| | |
|---|---|
| **Upstream** | `https://github.com/lukilabs/craft-agents-oss.git` |
| **Unser Remote** | `https://github.com/ontopoietic/orcha-agents.git` |
| **Zuletzt gemerged** | v0.9.1 |
| **Upstream-Stand** | v0.9.1 (aktuell) |
| **Aktiver Branch** | `main` |
| **Feature-Branch** | `feature/cross-session-recall` (Observer/Reflector/Recall — größter offener Block, → main, s. §6) |
| **Sentry** | Deaktiviert (main + renderer) — kein Reporting |

---

## Unsere Änderungen

### 1. Ledger UI

#### 1a. Ledger Navigator Panel — Session-Liste
Wenn die Ledger-Seite aktiv ist, zeigt der Navigator Panel (linke Spalte) die Session-Liste an (wie im Sessions-Tab), damit man schnell zwischen Sessions wechseln kann, ohne erst zurücknavigieren zu müssen.

**Neue Dateien:**
- `apps/electron/src/renderer/components/SyncHistoryList.tsx` — SyncHistoryList-Komponente (angelegt aber aktuell nicht genutzt; der Navigator zeigt stattdessen SessionList)

**Berührt Upstream-Dateien (Konflikt-Kandidaten):**
- `apps/electron/src/renderer/components/app-shell/AppShell.tsx` — `+isLedgerNavigation` Import, `+<SessionList key="ledger">` Block im NavigatorPanel (nach dem `isSessionsNavigation`-Block)
- `apps/electron/src/renderer/components/app-shell/SessionList.tsx` — `+isLedgerNavigation` Import, `currentFilter` gibt `{ kind: "allSessions" }` zurück wenn Ledger-Navigator aktiv (statt `undefined`)

#### 1b. Signal-Titel fett gerendert
Signal-Summaries (Format `"Titel: Beschreibung"`) zeigen den Teil vor dem ersten `:` in **fett**. Betrifft sowohl den Signals-Tab als auch die Sync-History-Accordion-Einträge.

**Neue Komponente (in bestehender Datei):**
- `RenderSignalSummary` in `LedgerDetailPage.tsx` — teilt Summary bei `:`, Titel bekommt `font-bold text-foreground`, Rest `text-foreground/70`

**Berührt Upstream-Dateien (Konflikt-Kandidaten):**
- `apps/electron/src/renderer/pages/LedgerDetailPage.tsx` — `+RenderSignalSummary`, 3x angewendet: Signals-Tab (`signal.summary`), Accordion-Signale (`s.summary`), Accordion-Candidates (`c.title`). Zudem Debug-Logging und verbesserter Empty-State-Text.

#### 1c. Ledger UI Basis
Echtzeitanzeige des `.orcha-ledger.json` im App-Sidebar und als eigene Detailseite. Zeigt Signale, Kandidaten, Obligations und Sync-History.

**Neue Dateien (kein Upstream-Konflikt):**
- `apps/electron/src/main/ledger-watcher.ts` — fs.watch auf `.orcha-ledger.json` + `.orcha-sync-history.json`
- `apps/electron/src/renderer/components/app-shell/LedgerPanel.tsx` — Sidebar-Panel mit Live-Aktivität
- `apps/electron/src/renderer/pages/LedgerDetailPage.tsx` — Vollbild-Detailseite mit History-Tab
- `apps/electron/src/shared/ledger-activity.ts` — Typen für LedgerData, SyncHistory, LedgerActivityEvent

**Berührt Upstream-Dateien (Konflikt-Kandidaten):**
- `apps/electron/src/renderer/components/app-shell/AppShell.tsx` — `+import LedgerPanel`, `+<LedgerPanel />` in Sidebar
- `apps/electron/src/renderer/components/app-shell/MainContentPanel.tsx` — `+isLedgerNavigation` Route
- `apps/electron/src/shared/types.ts` — `+ElectronAPI ledger*` Methoden, `+LedgerNavigationState`

**Weitere neue Dateien:**
- `apps/electron/src/preload/bootstrap.ts` — IPC-Bindings für Ledger
- `apps/electron/src/renderer/atoms/panel-stack.ts` — Panel-Stack-Atom
- `apps/electron/src/renderer/contexts/NavigationContext.tsx` — `+isLedgerNavigation`
- `apps/electron/src/shared/route-parser.ts` — Ledger-Route-Parsing
- `apps/electron/src/shared/routes.ts` — `+ledger` Route-Definition
- `apps/electron/src/transport/__tests__/channel-map-parity.test.ts` — IPC-Kanal-Tests

### 2. PreCompact Hooks
Ermöglicht Shell-Kommandos vor dem Context-Compaction-Event des Agents. Output wird dem Agent als "reason" zurückgegeben.

**Berührt Upstream-Dateien (Konflikt-Kandidaten):**
- `packages/shared/src/automations/automation-system.ts` — `+buildSdkHooks()`, PreCompact-Handler
- `packages/shared/src/automations/types.ts` — `+PreCompact` als `AgentEvent`
- `packages/shared/src/automations/schemas.ts` — Schema-Erweiterung für PreCompact
- `packages/shared/src/automations/automation-system.test.ts` — Tests für PreCompact
- `packages/shared/src/automations/name-utils.ts` — Hilfsfunktionen

**Neues Hauptmodul:**
- `apps/electron/src/main/index.ts` — PreCompact-Hook-Registrierung (IPC)

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
```bash
# Nach jedem electron:dist:dev:mac:
cp -R node_modules/@anthropic-ai/claude-agent-sdk "<app>/Contents/Resources/app/node_modules/@anthropic-ai/claude-agent-sdk"
cp /Users/timokurz/.bun/bin/bun "<app>/Contents/Resources/app/vendor/bun/bun"
cp -R packages/shared/src "<app>/Contents/Resources/app/packages/shared/src"
```

### 5. ZAI Models
Zusätzliche Modelle für den ZAI-Provider.

**Berührt Upstream-Dateien (Konflikt-Kandidaten):**
- `packages/server-core/src/model-fetchers/index.ts` — `+GLM-5.1`, `+GLM-5V-Turbo`
- `packages/shared/src/config/models-pi.ts` — ZAI-Modell-Konfiguration

### 6. Cross-Session Memory — Observer / Reflector / Recall (GRÖSSTER Block)

Eigenes Memory-System nach Mastras Modell (workspace-/resource-scoped Observations + bedeutungsbasiertes Recall), ein Monat Arbeit, ~57 neue + ~32 berührte Dateien. **Stark divergierend vom Upstream — der größte Rebase-Risikofaktor.** Architektur-Hintergrund: `sessions/260603-wide-sand/plans/HANDOFF-memory-architecture-pivot.md`.

Pipeline: **Observer** (Haiku, extrahiert pro Session Observations als Markdown-Ledger + Evidence-Sidecar) → **Auto-Anchor** (Haiku, taggt Observations mit Rahmen-Anchors feature/befund/anliegen) → **Reflector** (synthetisiert) → **Recall** (cross-session Retrieval-Tool + direktiver `<relevant_memory>`-Hint). Trigger feuern token-/count-basiert per Turn + Wake-on-Session-Open. Der frühere L3-**Episoden**-Layer ist als Agent-Memory abgelöst; Episoden bleiben nur als rein-menschlicher Sidebar-Phasen-Digest (`EpisodesViewer`).

**Neue Module (kein Upstream-Konflikt) — `packages/shared/src/sessions/`:**
- `mastra-om/*` (Observer/Reflector-Prompts, Parser, anchored-bullet-Parsing)
- `observation-{loader,trigger,watermark,markdown-parser,format.md}` — Ledger lesen/schreiben + Token-Trigger
- `recall-engine.ts` — cross-session recall() + resolvePointer() + gatherRecallHint()/renderRecallHintBlock()
- `reflection-trigger.ts`, `auto-anchor.ts`, `auto-anchor-trigger.ts` — Reflector- + Auto-Anchor-Trigger
- `rahmen-taxonomy.ts`, `episode*.ts` (Episoden = menschlicher Digest), `anchors.ts`

**Neue Skripte (detached, dev-mode) — `scripts/`:**
- `orcha-observe.ts`, `orcha-reflect.ts`, `orcha-recall.ts`, `orcha-recall-anchors.ts`, `orcha-migrate-observations.ts`, `orcha-episode-emit.ts`, `orcha-extract-artifacts.ts`, `lib/llm-extractor.ts`
- `lib/llm-extractor.ts` ist der EINZIGE LLM-Auth/Call-Pfad aller Skripte (OAuth → claude CLI, sonst API-Key). Der Legacy-Observer-Pfad (eigene Prompts, eigenes Auth-Plumbing, Pattern-Fallback, `ORCHA_OBSERVER_USE_MASTRA`-Switch) wurde Juni 2026 entfernt — `observations.md` ist seitdem read-only-Historie, geschrieben wird nur noch `observations.mastra.md`.
- Startup-Validierung: `validateOrchaScriptRuntime()` (`observer-runtime.ts`) prüft beim App-Start, dass alle vier spawnbaren Skripte auflösbar sind (paketiert: `dist/observer-scripts/*.cjs`); kaputte Builds zeigen einen Launch-Dialog statt still einzufrieren. Die Skriptliste (`ORCHA_SCRIPT_BASES`) ist Single Source of Truth für Build (`electron-build-main.ts`) und Spawn-Sites.

**Berührt Upstream-Dateien (Konflikt-Kandidaten):**
- `packages/shared/src/agent/core/prompt-builder.ts` — injiziert Observations + `<relevant_memory>`-Hint; feuert Observer/Reflector/Auto-Anchor-Trigger per Turn
- `packages/server-core/src/sessions/SessionManager.ts` — Observer-Wake on session-open; `maybeTriggerEpisode` on session-done/anchor-change
- `packages/shared/src/agent/session-self-management-bindings.ts` — bindet `recall` als Tool
- `packages/session-tools-core/src/{tool-defs,context,handlers/index,index}.ts` — `recall` als kanonisches Registry-Tool
- `packages/shared/src/agent/core/message-provider.ts`, `claude-agent.ts` — Streaming-Mode + Conversation-Tail
- `packages/shared/src/sessions/index.ts`, `protocol/dto.ts` — neue Exports/DTOs
- **UI:** `apps/electron/src/main/{index,observation-watcher}.ts`, `preload/bootstrap.ts`, `shared/{routes,route-parser,types}.ts`, `renderer/contexts/NavigationContext.tsx`, `renderer/components/anchors/SessionAnchorBar.tsx`, `renderer/components/app-shell/{AppShell,MainContentPanel,SessionList}.tsx`, `renderer/components/app-shell/input/FreeFormInput.tsx`, `renderer/hooks/useObservationStatus.ts` — Observations-Panel, Anchor-Bar, Episodes-Viewer, Context-%-Anzeige

**Semantic Recall (Vektor-Schicht, Juni 2026):** Die Text-Achse von `recall()` nutzt Embedding-Similarity statt nur Token-Overlap. Lokaler Embedder via `@huggingface/transformers` (`Xenova/multilingual-e5-small`, 384 dim, on-device, kein API-Key); per-Session-Cache `data/observations-embeddings.json` neben dem Evidence-Sidecar. Neue Module: `sessions/{embedder,vector-sidecar}.ts`, `recallSemantic()` in `recall-engine.ts`, Backfill `scripts/orcha-embed-observations.ts`. Bewusst KEINE Vektor-DB (Mastras libSQL/F32_BLOB-Pfad): bei Observation-Skala (~10²–10³ Vektoren) reicht Brute-Force-Cosine, null neue native DB-Dependency. Degradiert ohne Embedder automatisch auf Token-Overlap (`ORCHA_EMBED_DISABLE=1`). Modell-Cache: `~/.orcha-agents/models` (dev + paketiert geteilt, offline nach erstem Download). **Packaging (macOS):** `build:copy` (`apps/electron/scripts/copy-assets.ts`) staged ein minimales Embedder-Runtime nach `vendor/embedder/node_modules` (transformers + jinja + onnxruntime-node/-common, sharp-Stub statt nativem libvips, ONNX auf darwin getrimmt, WASM/Maps gepruned → ~79 MB); `electron-builder.yml` `mac.extraResources` merged es nach `app/node_modules`, erreichbar von `dist/main.cjs`. Hardened-Runtime lädt die unsignierte `.node` dank `disable-library-validation` (bereits gesetzt). **Offen:** Win/Linux-Packaging (dort Fallback auf Text-Scoring) und Pi-Subprozess-Backend (Recall im Pi-Bun-Prozess braucht analoges Staging; in-process Claude-Pfad ist abgedeckt).

> **Verhältnis zum Ledger (§1):** Der Observer übernimmt künftig die konversationsbasierte Signal-Extraktion, die zuvor Hauptaufgabe des Ledger/CLI-Sync war (s. orcha-side `~/Developer/orcha`). Ledger bleibt für die git-/artefakt-getriebene Achse; Umbau ist Folgearbeit.

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

---

## Upstream-Update-Anleitung

Bei einem neuen Upstream-Release:

```bash
# 1. Upstream-Änderungen holen
git fetch upstream

# 2. Diff analysieren — was überschneidet sich mit unseren Dateien?
git diff --name-only HEAD..upstream/main

# 3. Rebase auf neue Version
# Alle Branches die auf altem Upstream basieren updaten:
git checkout main
git rebase upstream/main
# → Konflikte in den Berührungspunkten (s.o.) manuell lösen

# 4. Build verifizieren
pnpm install
pnpm build

# 5. FORK.md aktualisieren (PFLICHT!)
# - "Zuletzt gemerged" auf neue Version setzen
# - "Upstream-Stand" auf "aktuell" setzen oder nächste ausstehende Version
# - Update-Protokoll ergänzen
# - Ggf. neue/entfernte Berührungspunkte anpassen

# 6. Committen
git add FORK.md
git commit -m "chore: rebase auf upstream vX.Y.Z, FORK.md aktualisiert"
```

> **Wichtig:** `FORK.md` ist Teil des Update-Prozesses. Nach jedem Rebase/Merge muss sie den aktuellen Stand widerspiegeln. Ohne aktuelle `FORK.md` ist der nächste Update-Aufwand schwerer einzuschätzen.
