# Fehler-Chronik: Orcha Agents Upgrade v0.8.3 → v0.8.6

Komplette Liste aller Fehler die beim Rebase/Upgrade auftraten, wie sie sich äußerten, was die Ursache war, und wie sie behoben wurden.

---

## 1. TypeScript-Kompilierungsfehler nach Rebase

**Symptom:** `bun run typecheck` schlägt fehl — fehlende Typen, unbekannte Imports.

**Ursache:** Upstream v0.8.5 führte neue Dependencies ein (`@tiptap/react`, `@tiptap/starter-kit`, `i18next`, `react-i18next`), die im Fork nicht korrekt aufgelöst wurden. Tiptap lag in zwei Versionen vor.

**Fix:**
- Tiptap auf exakt `3.22.3` gepinnt (ohne `^`)
- `@tiptap/core` und `@tiptap/pm` als Dependencies bzw. PeerDependencies in `packages/ui/package.json` hinzugefügt
- Commit: `b71421c`

---

## 2. esbuild-Build-Fehler: Sentry-Versionskonflikt

**Symptom:** `bun run electron:build:main` scheitert mit esbuild-Fehler — `@sentry/electron` erwartet andere `@sentry/core`-Version als installiert.

**Ursache:** Mehrere `@sentry/*`-Packages in unterschiedlichen Versionen im pnpm-Store (`10.47.0` vs `10.48.0`).

**Fix:** Alle `@sentry/*`-Packages via `pnpm.overrides` auf `10.48.0` geeint:
```json
"@sentry/core": "10.48.0",
"@sentry/react": "10.48.0",
"@sentry/node": "10.48.0",
"@sentry/electron": "7.11.0",
"@sentry/utils": "10.48.0"
```
Commit: `d28308a`

---

## 3. Orcha-Icons überschrieben

**Symptom:** Nach dem Rebase zeigen Dock-Icon und App-Icon wieder das Craft Agents Logo.

**Ursache:** Rebase hat Upstream-Änderungen an Icon-Dateien übernommen und unsere Orcha-Icons überschrieben.

**Fix:** Icons aus dem Branding-Commit restauriert:
```bash
git checkout 842b759 -- apps/electron/resources/icon.icns icon.png icon.ico icon.svg source.png
```
Commit: `53a291e`

---

## 4. Production-Crash: `MenuPortal must be used within Menu`

**Symptom:** Die gebaute App zeigt "Something went wrong" — Fehler-UI. Konsole zeigt dreimal `Error: 'MenuPortal' must be used within 'Menu'`.

**Ursache:** Zwei verschiedene Versionen von `@radix-ui/react-context` (`1.1.2` und `1.1.3`) im pnpm-Store erzeugten separate React Context-Instanzen. Radix UI's `MenuPortal` fand den Context des Eltern-`Menu` nicht.

**Fehldiagnose 1:** Zunächst vermutet: Duplicate `@sentry/browser`-Versionen ziehen doppeltes React rein → Sentry komplett aus Renderer entfernt. **Brachte keine Besserung.**

**Fehldiagnose 2:** `React.ErrorBoundary` verwendet — existiert nicht als React-Komponente. Eigene `AppErrorBoundary`-Klassenkomponente geschrieben.

**Korrekte Diagnose:** Source-Map-Analyse zeigte: Fehlerquelle war `@radix-ui/react-context@1.1.2` Zeile 38, aufgerufen von `@radix-ui/react-menu@2.1.16` → `StyledDropdown.tsx` Zeile 109.

**Fix:**
- `@radix-ui/react-context` auf `1.1.2` per `pnpm.overrides` fixiert
- Eigenen `AppErrorBoundary` statt `Sentry.ErrorBoundary` im Renderer
- Sentry komplett aus Renderer entfernt
- Commit: `b265865`

---

## 5. HTML-Titel zeigt "Craft Agents"

**Symptom:** Fenstertitel und DevTools-Titel zeigen "Craft Agents" statt "Orcha Agents".

**Ursache:** `apps/electron/src/renderer/index.html` hat `<title>Craft Agents</title>` — wurde beim Rebase nicht geändert.

**Fix:** `<title>` auf "Orcha Agents" geändert.
Commit: `323cc0e`

---

## 6. "Craft Agent" (Singular) in User-Strings

**Symptom:** In Settings, Onboarding und anderen UI-Bereichen steht "Craft Agent" (ohne "s") statt "Orcha Agents".

**Ursache:** Erster i18n-Replacement-Pass suchte nur nach "Craft Agents" (Plural). Upstream nutzt an 6 Stellen die Singular-Form ("How Craft Agent should address you", etc.) in 4 Locales.

**Fix:** Zweiter Pass suchte nach beiden Formen, ersetzte 24 Vorkommen in `en.json`, `es.json`, `ja.json`, `zh-Hans.json`.
Commit: `66078a3`

---

## 7. `pnpm-workspace.yaml` und `.npmrc` verloren

**Symptom:** Nach `rm -rf node_modules && pnpm install` konnten Workspace-Packages nicht aufgelöst werden — `@craft-agent/session-tools-core` nicht gefunden.

**Ursache:** `pnpm-workspace.yaml` wurde nie in Git getrackt und ging beim Clean-Install verloren. Ohne sie kennt pnpm die Workspace-Struktur nicht.

**Fix:**
- `pnpm-workspace.yaml` neu erstellt:
  ```yaml
  packages:
    - "packages/*"
    - "apps/*"
    - "!apps/online-docs"
  ```
- `.npmrc` mit `shamefully-hoist=true` und `node-linker=hoisted` erstellt
- Commit: `b265865`

---

## 8. Vite/Rollup kann `@craft-agent/shared/utils/toolNames` nicht resolven

**Symptom:** Renderer-Build scheitert: `Rollup failed to resolve import "@craft-agent/shared/utils/toolNames" from "packages/ui/src/components/chat/turn-utils.ts"`.

**Ursache:** `packages/ui` hat `@craft-agent/shared` als PeerDependency, aber keinen symlink auf das Package. Rollup resolvet von `packages/ui` aus und findet `@craft-agent/shared` nicht.

**Fix:** Manueller symlink:
```bash
mkdir -p packages/ui/node_modules/@craft-agent
ln -sf ../../../shared packages/ui/node_modules/@craft-agent/shared
```
Muss nach jedem `rm -rf node_modules` neu erstellt werden.

---

## 9. "Claude Code SDK not found. The app package may be corrupted."

**Symptom:** Beim Senden einer Nachricht in der Production-App erscheint dieser Fehler.

**Ursache:** `electron-builder.yml` schließt alle `node_modules` aus (`!node_modules/**/*`). Der `@anthropic-ai/claude-agent-sdk` wird über `extraResources` separat ins Bundle kopiert. Aber der `from:`-Pfad war relativ zu `apps/electron/`, während der SDK im Root-`node_modules/` liegt.

**Fix:** Alle 3 `extraResources`-Einträge korrigiert:
```yaml
# Vorher:
- from: node_modules/@anthropic-ai/claude-agent-sdk
# Nachher:
- from: ../../node_modules/@anthropic-ai/claude-agent-sdk
```
Commit: `669edb4`

---

## 10. `piServerPath not configured. Cannot spawn Pi subprocess.`

**Symptom:** Gleicher Fehler-Dialog wie #9, beim Versuch eine Session zu starten.

**Ursache:** Der `pi-agent-server` wird vom Build-Script kompiliert (`packages/pi-agent-server/dist/index.js`), aber nie in die App-Resources kopiert. Der Runtime-Resolver sucht in `{appRootPath}/dist/resources/pi-agent-server/index.js` — Datei fehlte.

Gleiches Problem betraf `session-mcp-server`.

**Fix:** `copy-assets.ts` erweitert um beide Server zu kopieren:
```typescript
const piServerSrc = join(ROOT_DIR, 'packages/pi-agent-server/dist/index.js');
const piServerDest = join('dist/resources/pi-agent-server/index.js');
copyFileSync(piServerSrc, piServerDest);
```
Commit: `bbd0d75`

---

## 11. GLM 5.1 hängt bei "thinking" / "percolating"

**Symptom:** GLM-5.1-Modell startet Session, bleibt aber bei "thinking" stehen ohne jemals zu antworten.

**Ursache:** Der Pi Agent Server wird mit `--target bun` kompiliert und braucht Bun zum Ausführen. Die App enthielt kein Bundled Bun — Fallback auf Electron's Node.js funktionierte nicht mit dem Bun-Bundle.

**Fix:** Bun-Download in `copy-assets.ts` integriert:
```typescript
const zipUrl = `https://github.com/oven-sh/bun/releases/download/bun-v1.3.9/bun-darwin-aarch64.zip`;
execSync(`curl -fsSL --retry 3 -o "${tmpZip}" "${zipUrl}"`);
execSync(`unzip -o -j "${tmpZip}" "bun-darwin-aarch64/bun" -d "vendor/bun/"`);
```
Landet in `apps/electron/vendor/bun/bun` (57MB, gitignored).
Commit: `669edb4`

---

## 12. Sentry-Reporting an Upstream

**Symptom:** Kein sichtbarer Fehler, aber Sentry-Events würden an lukilabs' Sentry-Projekt gesendet.

**Ursache:** Upstream hat `Sentry.init()` mit DSN im Main- und Renderer-Prozess. Fork soll nichts reporten.

**Fix:**
- **Main-Prozess:** `Sentry.init({ enabled: false })` — alle `captureException`/`setTag`-Calls werden No-Ops
- **Renderer-Prozess:** Alle Sentry-Imports entfernt, eigener `AppErrorBoundary` statt `Sentry.ErrorBoundary`
- Commit: `323cc0e` (Main), `b265865` (Renderer)

---

## 13. Dev-Mode: Electron beendet sich sofort

**Symptom:** `bun run electron:dev` startet Electron, aber es fährt sofort wieder herunter.

**Ursache:** `electron-dev.ts` setzt `CRAFT_CONFIG_DIR` auf leeren String wenn nicht als Env-Var gesetzt. Der Main-Process-Banner (`if(!process.env.CRAFT_CONFIG_DIR)`) überschreibt den leeren String nicht.

**Status:** Nicht kritisch — Production-App funktioniert. Im `orcha-upgrade`-Skill dokumentiert.

---

## Zusammenfassung

| # | Fehler | Phase | Versuche bis Fix |
|---|--------|-------|-----------------|
| 1 | TypeScript-Kompilierung | Nach Rebase | 1 |
| 2 | Sentry-Versionskonflikt (esbuild) | Build | 1 |
| 3 | Orcha-Icons überschrieben | Nach Rebase | 1 |
| 4 | `MenuPortal must be used within Menu` | Production Test | **3** (Sentry, React.ErrorBoundary, Radix Fix) |
| 5 | HTML-Titel "Craft Agents" | Production Test | 1 |
| 6 | "Craft Agent" Singular in Strings | Production Test | 2 (zweiter Pass nötig) |
| 7 | `pnpm-workspace.yaml` verloren | Clean Install | 1 |
| 8 | Rollup kann ToolNames nicht resolven | Build | **3** (Alias, symlink, shamefully-hoist) |
| 9 | Claude Code SDK not found | Production Test | **2** (Pfad-Fehldiagnose, dann korrekter Fix) |
| 10 | piServerPath not configured | Production Test | 1 |
| 11 | GLM 5.1 hängt | Production Test | 1 |
| 12 | Sentry-Reporting aktiv | Code Review | 1 |
| 13 | Dev-Mode sofort beendet | Dev Test | Nicht gefixt |

**Gesamt:** 13 Fehler, davon 5 die mehrere Versuche brauchten (Fehldiagnosen). Längste Debug-Session: #4 (MenuPortal-Crash) — ca. 3 Iterationen mit Source-Map-Analyse.
