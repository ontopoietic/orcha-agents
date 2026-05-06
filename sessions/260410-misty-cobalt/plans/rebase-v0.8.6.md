# Plan: Orcha Agents Fork-Update v0.8.3 → v0.8.6

## Kontext

Orcha Agents (Fork von `lukilabs/craft-agents-oss`) steht auf **v0.8.3**. Upstream ist mittlerweile bei **v0.8.6** (3 Versionen). Unser aktiver Branch: `feature/precompact-hooks` (7 eigene Commits).

### Was bringen die 3 Upstream-Versionen?

| Version | Key Features | Geändnete Dateien |
|---------|-------------|-------------------|
| **v0.8.4** | Generic OAuth, Send to Workspace, DevTools | 74 files |
| **v0.8.5** | **i18n** (1050+ Strings), Pi SDK 0.56→0.66 | ~166 files (viele UI) |
| **v0.8.6** | Chunked Session Transfers, Custom Endpoint Images | ~100 files |
| **Gesamt** | | **240 files** |

### Konflikt-Analyse

**3 Dateien** berühren sich (beide Seiten geändert):

| Datei | Unsere Änderung | Upstream-Änderung | Risiko |
|-------|----------------|-------------------|--------|
| `AppShell.tsx` | +`import LedgerPanel`, +`<LedgerPanel />` | `useAutomations()` 2. Param entfernt | 🟢 Niedrig |
| `MainContentPanel.tsx` | +`isLedgerNavigation` Route (11 Zeilen) | +Send-to-Workspace, Automation Multi-Select (52 Zeilen) | 🟡 Mittel |
| `types.ts` | +`ledger*` Methoden, `LedgerNavigationState` (23 Zeilen) | +Resource-Bundle-Typen, +`getAutomations` (11 Zeilen) | 🟢 Niedrig |

**Kein Konflikt** (unsere exklusiven Bereiche):
- Alle Ledger-UI-Dateien (`LedgerPanel.tsx`, `LedgerDetailPage.tsx`, etc.)
- PreCompact Hooks (`automations/automation-system.ts`, `schemas.ts`, `types.ts`, etc.)
- ZAI Models (`model-fetchers/index.ts`, `models-pi.ts`)

---

## Vorgehen

### Option A: Rebase (empfohlen)
Sauberere History, 7 Commits werden auf v0.8.6 neu aufgesetzt. Force-Push nötig.

### Option B: Merge
Merge-Commit behält History, kein Force-Push nötig. Aber verschachtelte History.

**→ Ich empfehle Option A (Rebase)**, da wir nur 7 Commits haben und die History dadurch linear bleibt.

---

## Schritte

### 1. Vorbereitung
- `git stash` falls uncommitted Changes existieren
- `git fetch upstream` — holt v0.8.4, v0.8.5, v0.8.6

### 2. Rebase
```
git checkout feature/precompact-hooks
git rebase upstream/main
```

### 3. Konflikte lösen (3 Dateien)

**AppShell.tsx:**
- Upstream: Zeile mit `useAutomations(activeWorkspaceId, activeWorkspace?.rootPath)` → `useAutomations(activeWorkspaceId)` übernehmen
- Unsere LedgerPanel-Imports und `<LedgerPanel />` behalten

**MainContentPanel.tsx:**
- Upstream: +`automationSelection` Import, +`SendResourceToWorkspaceDialog`, +Multi-Select State, +`wrapWithStoplight` Enhancement übernehmen
- Unsere `isLedgerNavigation` Route-Logik behalten
- Beide Änderungen sind in verschiedenen Code-Bereichen → trivial mergebar

**types.ts:**
- Upstream: +Resource-Bundle-Typen, +`getAutomations`, +`exportResources`/`importResources` übernehmen
- Unsere `ledger*` Methoden und `LedgerNavigationState` behalten
- Beide fügen Typen in verschiedenen Bereichen hinzu → trivial mergebar

### 4. Build verifizieren
```
pnpm install
pnpm build
```

### 5. FORK.md aktualisieren
- "Zuletzt gemerged" → `v0.8.6`
- "Upstream-Stand" → `v0.8.6 (aktuell)`
- Update-Protokoll ergänzen
- Berührungspunkte prüfen/ggf. anpassen

### 6. Committen & Push
```
git add FORK.md
git commit -m "chore: rebase auf upstream v0.8.6, FORK.md aktualisiert"
git push --force-with-lease origin feature/precompact-hooks
```

---

## Risiko-Bewertung

- **Gesamtrisiko: Niedrig** — nur 3 von 240 Upstream-Dateien überschneiden sich mit unseren Änderungen
- Alle 3 Konflikte sind in verschiedenen Code-Bereichen → keine inhaltlichen Konflikte
- Unsere exklusiven Dateien (Ledger UI, PreCompact Hooks, ZAI Models) sind vollständig konfliktfrei

## Zeitaufwand

~15–30 Minuten (inkl. Build-Verifikation)
