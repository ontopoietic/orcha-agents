# Fix: Ledger Sync History wird nicht in der UI angezeigt

## Problem

Die **Sync History Tab** in der Ledger Detail Page zeigt immer "Noch kein Sync durchgeführt", obwohl die Datei `.orcha-sync-history.json` im Projektverzeichnis existiert und Sync-Runs enthält.

## Root Cause

Die aktuell laufende **Orcha Agents.app** (`/Applications/Orcha Agents.app/`) wurde aus einer **alten Release-Build** installiert, die **vor** dem Hinzufügen der Sync History Features erstellt wurde. Der Quellcode im Repo ist korrekt und vollständig – aber die kompilierte/verpackte App enthält veraltete Dateien.

### Was in den Quelldateien korrekt ist ✅

| Datei | Status |
|-------|--------|
| `apps/electron/src/shared/ledger-activity.ts` | Hat `LedgerData`, `SyncHistory`, `SyncHistoryRun`, etc. |
| `apps/electron/src/main/ledger-watcher.ts` | Hat `readSyncHistory()` + `readFullLedger()` |
| `apps/electron/src/preload/bootstrap.ts` | Hat `ledgerRead()` + `ledgerHistory()` IPC-Brücken |
| `apps/electron/src/main/index.ts` | Hat `ledger:read` + `ledger:history` IPC-Handler |
| `apps/electron/src/renderer/pages/LedgerDetailPage.tsx` | Hat `HistoryTab` + `HistoryRunRow` Komponenten |

### Was in der installierten App fehlt ❌

| Datei in `/Applications/Orcha Agents.app/` | Fehlt |
|---------------------------------------------|-------|
| `.../shared/ledger-activity.ts` | Alle Typen außer `LedgerSignalDelta` + `LedgerActivityEvent` |
| `.../main/ledger-watcher.ts` | `readSyncHistory()` und `readFullLedger()` |
| `.../preload/bootstrap.ts` | `ledgerRead()` und `ledgerHistory()` |
| `.../main/index.ts` | `ledger:read` und `ledger:history` IPC-Handler |
| `.../dist/main.cjs` (kompiliert) | Alle oben genannten Funktionen |

### Was im Renderer passiert

```ts
// LedgerDetailPage.tsx — defensive Abfrage:
const hasHistoryApi = typeof window.electronAPI?.ledgerHistory === 'function'
// → false! Weil die alte bootstrap.ts kein ledgerHistory registriert

// Fallback mit leerem Ergebnis:
hasHistoryApi
  ? window.electronAPI.ledgerHistory(workingDirectory)
  : Promise.resolve({ version: 1, runs: [] })  // ← das wird zurückgegeben
// → "Noch kein Sync durchgeführt"
```

## Fix

**Neu bauen und installieren** der Orcha Agents App. Der Quellcode ist korrekt – es muss nur ein neuer Release erstellt werden.

### Schritte

1. **Release-Build erstellen:**
   ```bash
   cd ~/Developer/craft-agents-oss
   bun run electron:dist:dev:mac
   ```
   Dies kompiliert die aktuellen Quelldateien in eine neue `.app`-Bundle.

2. **Alte App ersetzen:**
   - Beende die laufende Orcha Agents App
   - Kopiere `apps/electron/release/mac/Orcha Agents.app` nach `/Applications/`
   - Starte die App neu

### Was sich danach ändert

- `ledgerHistory()` ist im Preload verfügbar → `hasHistoryApi === true`
- `readSyncHistory()` liest `.orcha-sync-history.json` aus dem Projektverzeichnis
- Sync History Tab zeigt die vergangenen Sync-Runs mit allen Details

### Kein Code-Change nötig

Alle Quelldateien sind korrekt. Es ist rein ein Build/Deployment-Problem.
