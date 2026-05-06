# Plan: Upgrade Orcha Agents auf upstream v0.9.1

## Ziel
Fork von v0.8.9 auf v0.9.1 heben, primär um den Session-Loader-Robustheits-Fix `d5a31774` (Cold-Session Hydration) einzuziehen — mutmaßlicher Fix für den wiederkehrenden UI-Freeze, ausgelöst durch Sessions mit alter `api-error.json`. Sekundär weitere Robustheits-Fixes (`d8262fab`, `3a2f7b6b`, Composer Error Boundary) und 4 Versionen Backlog abarbeiten.

## Ausgangslage
- Aktueller Branch: `feature/sync-skill-indicator` (2 Commits ahead von `main`: docs `0398e5b`, feat `ab73e76`)
- `main` auf `a9ed41e` (v0.8.9). Divergenz `main...upstream/main`: 23 ahead, 8 behind
- 18 von 18 in FORK.md gelisteten Touchpoints haben Upstream-Änderungen → Konflikte erwartet
- Working Tree: einige Untracked Files (sessions/, statuses/, vendor/, config.json, etc.) — bleiben unangetastet
- FORK.md erwähnt noch alten Feature-Branch `feature/precompact-hooks` — muss aktualisiert werden

## Risiken
1. **v0.9.0 Claude SDK native-binary Migration** — Bundle-Layout für `extraResources` ändert sich, Build-Resource-Pfade in `electron-builder.yml` brauchen möglicherweise Anpassung. FORK.md "Claude Code SDK not found"-Pitfall ist genau dieser Fall.
2. **Viele Touchpoints in `packages/shared/src/automations/*`** — PreCompact-Hook Code könnte mit upstream-Refactorings kollidieren.
3. **i18n Locales** — bei jedem Upgrade die "Craft Agents" → "Orcha Agents" Ersetzung neu durchziehen.
4. **Kein dedizierter Freeze-Fix-Commit identifiziert** — Upgrade ist Best-Guess, könnte Bug nicht beheben. Wir akzeptieren das, weil 4 Versionen Backlog ohnehin überfällig sind.

## Schritte

### Phase 1 — Vorbereitung & Sicherung
1. Working Tree aufräumen / sichern: in `~/Developer/orcha-agents` git status prüfen, untracked Files belassen, nichts stagen
2. Sicherheitsbranch erstellen: `git branch backup/pre-v0.9.1-$(date +%Y%m%d) main`
3. Feature-Branch sichern: `git branch backup/feature-sync-skill-$(date +%Y%m%d) feature/sync-skill-indicator`
4. Falls noch nicht: `git fetch upstream --tags` (schon erledigt)

### Phase 2 — Rebase main auf upstream/main
1. `git checkout main`
2. `git rebase upstream/main` — interaktiv, Konflikte per Commit auflösen
3. Erwartete Konfliktstellen (laut FORK.md + Diff-Analyse):
   - `apps/electron/src/renderer/components/app-shell/AppShell.tsx` — Ledger-Panel + Navigator-Block, beide Branches behalten
   - `apps/electron/src/renderer/components/app-shell/SessionList.tsx` — `isLedgerNavigation` Filter
   - `apps/electron/src/renderer/components/app-shell/MainContentPanel.tsx` — Ledger-Route
   - `apps/electron/src/renderer/components/app-shell/LedgerPanel.tsx` — sync-skill Indicator (kürzlich hinzugefügt)
   - `apps/electron/src/renderer/pages/LedgerDetailPage.tsx` — RenderSignalSummary, fett-Titel
   - `apps/electron/src/main/index.ts` — `CRAFT_CONFIG_DIR=~/.orcha-agents`, PreCompact-Hooks, userData-Pfad
   - `apps/electron/electron-builder.yml` — `appId=com.ontopoietic.orcha-agents`, prüfen ob v0.9.0 native-binary `extraResources` nachzieht
   - `apps/electron/package.json` — Name "orcha-agents", Version
   - `packages/shared/src/automations/{automation-system,types,schemas}.ts` — PreCompact-Hooks
   - `packages/shared/src/agent/backend/internal/runtime-resolver.ts` — `CRAFT_BUN`-Fallback + interceptor-not-found-as-warning
   - `packages/server-core/src/sessions/SessionManager.ts` — try-catch in sendMessage + 5-min Watchdog (PFLICHT behalten)
   - `packages/server-core/src/model-fetchers/index.ts` — GLM-5.1 + GLM-5V-Turbo
   - `packages/shared/src/config/models-pi.ts` — ZAI-Modelle
   - `apps/electron/src/shared/{types,route-parser,routes}.ts` — Ledger-Routes
4. Konflikt-Auflösungsregeln (aus SKILL.md):
   - **Keep both** für IPC-Handler, Route-Registrierungen, Export-Listen
   - **Upstream `t()`-Calls übernehmen**, aber Locale-VALUES weiter "Orcha Agents" halten
   - **Orcha-Branding behalten** (Icons, App-Name, AppId)
   - **i18n-Keys unverändert** lassen (nur Werte in JSON ändern)
   - **Resilience-Fixes behalten**: SessionManager try-catch + Watchdog, runtime-resolver Warning
5. Nach jedem `git rebase --continue`: TypeScript schnell prüfen (kein Full-Build, nur grep auf offensichtliche Brüche)

### Phase 3 — Locale-Files reparieren
1. `grep -rn "Craft Agents\|Craft Agent" apps/electron/src/i18n/ 2>/dev/null || grep -rn "Craft Agents\|Craft Agent" apps/electron/src/locales/` (Pfad ggf. nachjustieren)
2. Alle Vorkommen → "Orcha Agents" / "Orcha Agent" (Singular und Plural prüfen!)
3. Keine i18n-Keys umbenennen

### Phase 4 — Native-Binary Claude SDK (v0.9.0 Migration)
1. `electron-builder.yml` `extraResources` checken — bringt v0.9.0 die Pfade mit, oder müssen wir nachpflegen?
2. `node_modules/@anthropic-ai/claude-agent-sdk-binary` muss existieren nach `pnpm install`
3. `@vscode/ripgrep` als top-level dep prüfen
4. Falls Custom-`copy-assets.ts` greift, mit upstream alignen

### Phase 5 — Verifikation Build
1. Clean install:
   ```bash
   rm -rf node_modules apps/*/node_modules packages/*/node_modules
   pnpm install
   node node_modules/electron/install.js
   mkdir -p packages/ui/node_modules/@craft-agent
   ln -sf ../../../shared packages/ui/node_modules/@craft-agent/shared
   ```
2. `bash scripts/verify-orcha-build.sh` — alle 28 Items grün
3. Prod-Build: `bun run electron:dist:mac`
4. App ersetzen + Smoke-Test:
   ```bash
   rm -rf "/Applications/Orcha Agents.app"
   cp -R apps/electron/release/mac-arm64/Orcha\ Agents.app /Applications/
   ```
5. Funktional manuell prüfen: Send Message, Sidebar-Branding, Window-Title, Ledger-Panel, Console für Sentry-Errors

### Phase 6 — Freeze-Bug-Probe (der eigentliche Anlass)
1. `~/.orcha-agents/workspaces/orcha/sessions/260505-tall-bobcat.BROKEN` zurück zu `260505-tall-bobcat` benennen
2. App starten, Workspace `Orcha` wählen, Session-Liste rendern
3. Beobachten ob UI klickbar bleibt; falls ja: v0.9.1's `d5a31774` hat den Bug gefixt → bestätigt
4. Falls nicht: `.BROKEN` wieder zurück, App weiter benutzbar; danach gezielte RCA im Renderer-Code (aber außerhalb dieses Plans)

### Phase 7 — Feature-Branch nachziehen
1. `git checkout feature/sync-skill-indicator`
2. `git rebase main` — die 2 Fork-spezifischen Commits (`0398e5b`, `ab73e76`) auf neuen main legen
3. Bei Konflikten in `LedgerPanel.tsx` / `FORK.md` manuell auflösen

### Phase 8 — Commit, FORK.md, Push
1. FORK.md updaten:
   - "Zuletzt gemerged" → v0.9.1
   - "Upstream-Stand" → v0.9.1 (aktuell)
   - Update-Protokoll-Zeile ergänzen: 2026-05-06, v0.8.9 → v0.9.1, Konflikte: <Liste>, Timo + Craft Agent
   - Feature-Branch-Eintrag von `feature/precompact-hooks` auf `feature/sync-skill-indicator` korrigieren
   - Falls v0.9.0 Native-Binary-SDK neue Conflict-Candidates erzeugt hat → Liste anpassen
2. `git add -A` (gezielt: keine session-files), commit:
   ```
   chore: upgrade to upstream v0.9.1
   
   - Rebase fork commits onto upstream/main
   - Resolve conflicts in: <Liste>
   - Update Orcha branding in i18n locales
   - Adopt v0.9.0 Claude SDK native-binary distribution
   - Preserve fork resilience fixes (SessionManager watchdog, runtime-resolver warning)
   
   Primary motivation: pull in d5a31774 (cold-session hydration fix)
   to address recurring UI freeze on workspaces with stale api-error.json.
   
   Co-Authored-By: Craft Agent <agents-noreply@craft.do>
   ```
3. `git push origin main --force-with-lease`
4. Feature-Branch pushen: `git push origin feature/sync-skill-indicator --force-with-lease`

## Abbruch-Kriterien
- Wenn der Rebase mehr als 30 Minuten Konflikt-Auflösung pro Commit braucht → pausieren, mit dir abstimmen
- Wenn `verify-orcha-build.sh` rote Items zeigt, die nicht trivial behebbar sind → Rebase nicht pushen, in Backup-Branch zurück
- Wenn die App nach Build nicht startet oder direkt crasht → Backup-Branch wiederherstellen, RCA separat

## Was NICHT in diesem Plan ist
- Root-Cause-Analyse des Freeze-Bugs falls v0.9.1 ihn nicht behebt — separater Folge-Task
- Update der `orcha-agents-upgrade` SKILL.md mit Lessons Learned aus diesem Upgrade — am Ende, separat
- Cleanup der Untracked Files im Working Tree (statuses/, vendor/, etc.)
