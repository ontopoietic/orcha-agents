# Fix: Network Interceptor Error & Stuck Queue Recovery

## Problem

Zwei zusammenhängende Bugs:
1. **"Network interceptor not found"** — `prepareRuntime()` wirft im strict mode, weil `interceptor.cjs` im gepackten App-Bundle fehlt oder der Pfad nicht aufgelöst werden kann
2. **"queued" hängt fest** — Fehler in `prepareRuntime()` propagieren unkontrolliert, `onProcessingStopped()` wird nie aufgerufen, `isProcessing` bleibt `true`, Queue blockiert

## Root Cause

Die Fehlerkette hat **drei Lücken**:

| Lücke | Datei | Zeile | Problem |
|-------|-------|-------|---------|
| 1 | `factory.ts` | 175 | `driver.prepareRuntime()` hat kein try-catch |
| 2 | `SessionManager.ts` | ~4968 | `getOrCreateAgent()` in `sendMessage()` hat kein try-catch |
| 3 | `SessionManager.ts` | ~5546 | `processNextQueuedMessage()` fängt zwar `.catch()` ab, aber ohne spezifische Fehlertypisierung |

## Plan

### Schritt 1: Error Handling in `sendMessage()` erweitern
**Datei:** `packages/server-core/src/sessions/SessionManager.ts`

`getOrCreateAgent(managed)` (Zeile ~4968) in try-catch wrappen:

```typescript
let agent: AgentInstance;
try {
  agent = await this.getOrCreateAgent(managed);
} catch (err) {
  const errorMessage = err instanceof Error ? err.message : 'Failed to initialize agent';
  sessionLog.error('Agent initialization failed:', err);

  this.sendEvent({
    type: 'error',
    sessionId,
    error: errorMessage,
  }, managed.workspace.id);

  this.onProcessingStopped(sessionId, 'error');
  return;
}
```

**Effekt:** Wenn `prepareRuntime()` fehlschlägt, wird `onProcessingStopped()` sauber aufgerufen → Queue wird nicht blockiert, Fehler wird dem User angezeigt.

### Schritt 2: Graceful Degradation in `prepareRuntime()`
**Datei:** `packages/shared/src/agent/backend/internal/runtime-resolver.ts`

In `applyAnthropicRuntimeBootstrap()` (Zeile ~237): Wenn der Interceptor nicht gefunden wird, **warnen statt werfen** — der Interceptor ist für Tool-Metadata zuständig, nicht für die Kernfunktionalität:

```typescript
if (paths.claudeInterceptorPath) {
  setInterceptorPath(paths.claudeInterceptorPath);
} else if (strict) {
  // Warn but don't throw — interceptor is for metadata enrichment, not core functionality
  console.warn('[runtime] Network interceptor not found — tool metadata will be unavailable');
}
```

**Effekt:** Sessions können auch ohne Interceptor starten. Tool-Metadata (`_intent`, `_displayName`) fehlt dann, aber die Kernfunktionalität bleibt erhalten.

### Schritt 3: Stuck-Session Watchdog
**Datei:** `packages/server-core/src/sessions/SessionManager.ts`

Einen einfachen Timeout-Mechanismus in `sendMessage()` einbauen, der `isProcessing` nach einer konfigurierbaren Zeit (z.B. 5 Minuten) automatisch zurücksetzt:

```typescript
// In sendMessage(), nach setProcessing(managed, true):
managed.processingTimeout = setTimeout(() => {
  if (managed.isProcessing) {
    sessionLog.warn(`Session ${sessionId} stuck in processing for >5min, forcing recovery`);
    this.onProcessingStopped(sessionId, 'timeout');
  }
}, 5 * 60 * 1000);

// In onProcessingStopped(): Timeout clearen
if (managed.processingTimeout) {
  clearTimeout(managed.processingTimeout);
  managed.processingTimeout = undefined;
}
```

**Effekt:** Selbst wenn unvorhergesehene Fehler auftreten, wird die Session nach 5 Minuten automatisch recovered.

## Dateien die geändert werden

1. `packages/server-core/src/sessions/SessionManager.ts` — Error handling + Watchdog
2. `packages/shared/src/agent/backend/internal/runtime-resolver.ts` — Graceful degradation

## Risiken & Überlegungen

- **Schritt 2** ändert das Verhalten: Sessions starten ohne Interceptor → `_intent`/`_displayName` Metadata fehlt in API-Requests. Das ist akzeptabel, da es nur UI-Enrichment betrifft.
- **Schritt 3** muss den Timeout bei normalen Long-Running-Sessions (z.B. Code-Ausführung) berücksichtigen — 5 Minuten sollte ausreichend sein, aber ggf. anpassen.
- Branch: `fix/interceptor-stuck-queue-recovery`
