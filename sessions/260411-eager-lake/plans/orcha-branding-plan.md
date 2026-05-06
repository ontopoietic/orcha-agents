# Orcha Agents — Branding & Polish

Branch: `feature/orcha-branding` (von `feature/precompact-hooks`)

---

## A. Logo austauschen

Das hochgeladene Pixel-"O"-Logo ersetzt alle Icon-Dateien.

### Schritte

1. **Hochgeladenes Bild → `source.png` kopieren**
   - Quelle: `sessions/260411-eager-lake/attachments/81ab7866-…_generated-image.png`
   - Ziel: `apps/electron/resources/source.png`

2. **`generate-icons.sh` ausführen**
   - Generiert `icon.icns` (macOS), `icon.png` (Linux 512×512), `icon.ico` (Windows, braucht ImageMagick)

3. **Liquid Glass SVG aktualisieren**
   - `apps/electron/resources/icon.svg` — neues SVG des Pixel-O erstellen
   - `apps/electron/resources/icon.icon/Assets/icon.svg` — gleiche SVG-Datei

4. **`Assets.car` neu kompilieren** (macOS 26 Liquid Glass)
   ```bash
   cd apps/electron
   xcrun actool "resources/icon.icon" --compile "resources" \
     --app-icon AppIcon --minimum-deployment-target 26.0 \
     --platform macosx --output-partial-info-plist /dev/null
   ```
   → Löst auch das **Dock-Icon-wird-weiß-Problem**: Die `Assets.car` wurde gelöscht, daher fehlt das Liquid Glass Icon und macOS 26 zeigt einen weißen Fallback.

---

## B. Agent-Identität: "Craft Agent" → "Orcha Agent"

Der Agent identifiziert sich als "Craft Agent" weil der Name im System-Prompt hardcoded ist.

### Dateien & Änderungen

| Datei | Zeile | Ist | Soll |
|---|---|---|---|
| `packages/shared/src/prompts/system.ts` | 463 | `You are Craft Agent - an AI assistant…` | `You are Orcha Agent - an AI assistant…` |
| `packages/shared/src/prompts/system.ts` | 559 | `refer to yourself as Craft Agent` | `refer to yourself as Orcha Agent` |
| `packages/shared/src/prompts/system.ts` | 566 | `Co-Authored-By: Craft Agent` | `Co-Authored-By: Orcha Agent` |
| `packages/shared/src/prompts/system.ts` | 313 | `configuration edits in Craft Agent` | `configuration edits in Orcha Agent` |
| `packages/shared/src/prompts/system.ts` | 1078 | `Craft Agent development team` | `Orcha Agent development team` |

---

## C. UI-Strings: "Craft Agents" → "Orcha Agents"

Alle user-sichtbaren Stellen in der Electron-App.

### Dateien & Änderungen

| Datei | Was |
|---|---|
| `apps/electron/src/renderer/components/onboarding/WelcomeStep.tsx` | "Welcome to Craft Agents" → "Welcome to Orcha Agents" |
| `apps/electron/src/renderer/components/onboarding/CompletionStep.tsx` | "Craft Agents" Erwähnung |
| `apps/electron/src/renderer/components/onboarding/ProviderSelectStep.tsx` | "Craft Agents" Label |
| `apps/electron/src/renderer/components/onboarding/ReauthScreen.tsx` | "Craft Agents" Text |
| `apps/electron/src/renderer/components/SplashScreen.tsx` | Splash-Text |
| `apps/electron/src/renderer/components/AppMenu.tsx` | Menü-Strings ("About Craft Agents" etc.) |
| `apps/electron/src/renderer/components/app-shell/TopBar.tsx` | Window-Titel |
| `apps/electron/src/renderer/playground/PlaygroundApp.tsx` | Playground-Titel |
| `apps/electron/package.json` | `"description": "Electron desktop app for Craft Agents"` |

### Komponenten-Dateien umbenennen

| Ist | Soll |
|---|---|
| `CraftAgentsSymbol.tsx` | `OrchaAgentsSymbol.tsx` |
| `CraftAgentsLogo.tsx` | `OrchaAgentsLogo.tsx` |

Alle Imports in den oben genannten Dateien entsprechend anpassen.

---

## D. Auto-Update deaktivieren

Die Fork kann nicht vom Original-Update-Server (`agents.craft.do`) aktualisiert werden. Ein Update würde die Fork mit der Original-App überschreiben.

### Schritte

1. **Update-Check beim Start deaktivieren**
   - `apps/electron/src/main/auto-update.ts` Zeile 115-118: `autoUpdater.autoDownload = false`
   - `checkForUpdatesOnLaunch()` → Early Return mit Log-Hinweis "Auto-update disabled in fork"

2. **Settings UI: "Check for Updates" ausblenden**
   - `apps/electron/src/renderer/pages/settings/AppSettingsPage.tsx` Zeile 323-348: Update-Sektion verstecken oder durch Hinweis "Updates are managed manually" ersetzen

3. **Menü-Eintrag anpassen**
   - `apps/electron/src/main/menu.ts` Zeile 58-84: "Check for Updates" → entfernen oder deaktivieren

4. **electron-builder.yml** Zeile 73-76: `publish` Sektion auskommentieren (verhindert, dass der Updater die URL baked)

---

## Nicht ändern (bewusst ausgeschlossen)

| Was | Warum |
|---|---|
| GitHub-Repo-URLs (`craft-agents-oss`) | Repo-Name bleibt gleich |
| MCP Source ID `craft-agents-docs` | Interne ID, würde bestehende Workspaces brechen |
| Package-Names (`@craft-agent/*`) | Interne npm-Scoping, kein User-Impact |
| Feature Flag `isCraftAgentsCliEnabled()` | Rein interner Code-Bezeichner |
| Lock-Datei `craft-agents-fork.lock` | Laufzeit-Erkennung, Umbenennung bricht laufende Instanzen |
| Deep Link Protocol | Falls registriert, würden bestehende Links brechen |
| `TRADEMARK.md`, `SECURITY.md` | Upstream-Docs, sollten Original-Referenzen behalten |
| Auth User-Agent Header | API-seitige Kompatibilität |

---

## Reihenfolge & Commits

1. `feat: replace app icon with new Orcha pixel-O logo` — Phase A
2. `feat: rename agent identity from Craft Agent to Orcha Agent in system prompt` — Phase B
3. `feat: rename Craft Agents → Orcha Agents in all UI strings` — Phase C
4. `feat: disable auto-update for fork` — Phase D

Jeder Schritt wird einzeln committed und getestet bevor der nächste beginnt.
