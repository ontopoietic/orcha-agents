# Update orcha-agents-upgrade Skill

## Änderungen an `skills/orcha-agents-upgrade/SKILL.md`

### 1. Known Pitfalls Reference — zwei neue Einträge

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Network interceptor not found. The app package may be corrupted.` | Interceptor-Pfad konnte nicht aufgelöst werden nach Rebase (Pfad-Änderungen upstream) | Seit `fix/interceptor-stuck-queue-recovery` nur noch Warning statt Fatal — Session startet ohne Tool-Metadata. Prüfen ob `interceptor.cjs` im Build liegt |
| Session hängt bei "queued" nach Auth-Error | `getOrCreateAgent()` wirft, `onProcessingStopped()` wird nie aufgerufen → `isProcessing` bleibt `true` | Seit `fix/interceptor-stuck-queue-recovery` gefixed: try-catch um Agent-Init + 5-Min Watchdog. Beim Rebase sicherstellen, dass diese Änderungen in `SessionManager.ts` und `runtime-resolver.ts` erhalten bleiben |

### 2. Functional Tests — neuer Test hinzufügen

In Sektion "3.4 Functional Tests (Manual)" ergänzen:
- **7. Queue Recovery** — Wenn ein Fehler bei Agent-Init auftritt (z.B. falsches Model), sollte die Session einen Error anzeigen und nicht in "queued" hängenbleiben. Nachfolgende Nachrichten sollten normal verarbeitet werden.

### 3. Conflict Candidates Hinweis

In Step 1 einen Hinweis ergänzen, dass bei Rebases besonders auf Änderungen in diesen Dateien zu achten ist:
- `packages/server-core/src/sessions/SessionManager.ts` (getOrCreateAgent try-catch, setProcessing watchdog)
- `packages/shared/src/agent/backend/internal/runtime-resolver.ts` (interceptor graceful degradation)

Diese enthalten fork-spezifische Resilience-Fixes die upstream nicht existieren.
