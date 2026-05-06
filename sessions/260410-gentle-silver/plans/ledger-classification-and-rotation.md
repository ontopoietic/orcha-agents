# Plan: Ledger-Klassifizierung & Struktur-Verbesserung

## Problem 1: Alle Candidates landen als "unknown"

### Diagnose

Die Pipeline funktioniert so:
1. **Signale sammeln** → `collectSignals()` erstellt `RawSignal` mit `summary`-Text
2. **Klassifizieren** → `classifyCandidates()` erstellt `Candidate` mit `candidateType` via `inferCandidateType()`
3. **History speichern** → `appendSyncHistory()` mappt `c.category ?? c.type ?? "unknown"`

Der Fehler liegt in **Schritt 2 → 3**: 
- `Candidate` hat ein Feld `candidateType` (z.B. "decision", "preference", "episodic")
- Aber `appendSyncHistory()` sucht nach `c.category` und `c.type` — **die beide nicht existieren**
- `candidateType` wird nicht gemappt → Fallback "unknown"

```ts
// ledger.ts — appendSyncHistory (ZEILE ~88)
category: c.category ?? c.type ?? "unknown"
//              ↑ existiert nicht    ↑ existiert nicht    ↑ IMMER das Ergebnis
```

Die Signale im fraglichen Run waren **Conversation-Signale** (Onboarding-Konzept-Erkenntnisse). Ihre Summaries beginnen mit Strings wie "Konzept-Erkenntnis:", "Designprinzip Onboarding:", "Lücke im Onboarding-Konzept:" — die **keines** der Regex-Patterns in `TYPE_PATTERNS` matchen. Also fällt `inferCandidateType()` auf `null` zurück, und `classifyCandidates()` setzt `candidateType: "episodic"` (Default). Aber das wird in der History nicht sichtbar, weil das Mapping-Feld falsch ist.

### Fix

**In `ledger.ts` → `appendSyncHistory()`** — korrektes Feld mappen:

```ts
// VORHER:
category: c.category ?? c.type ?? "unknown"

// NACHHER:
category: c.candidateType ?? c.category ?? "unknown"
```

Das ist ein Einzeiler, der das bereits korrekt klassifizierte `candidateType`-Feld verwendet.

---

## Problem 2: Conversation-Signale werden nie typisiert

Selbst mit dem obigen Fix würden die 8 Conversation-Signale alle als `candidateType: "episodic"` klassifiziert — weil ihre Summaries keine der Regex-Patterns matchen. Die Patterns decken hauptsächlich **Artefakt-Signale** ab (die mit Präfixen wie "Neue Entscheidung:", "Aktive Präferenz:").

Conversation-Signale wie "Konzept-Erkenntnis: Onboarding produziert ein Kunden-Modell" haben keine dieser Signalwörter.

### Fix: Erweiterte Pattern-Abdeckung

In `candidates.ts` → `TYPE_PATTERNS`, zusätzliche Patterns hinzufügen:

```ts
// Konzept-Erkenntnisse → decision (oder neues Type "insight")
[/konzept-?erkenntnis|insight|erkenntnis:/i, "decision"],

// Designprinzipien → preference
[/designprinzip|design-prinzip|prinzip:/i, "preference"],

// Lücken/Fehlendes → finding
[/lücke|fehlt|fehlende? |nicht vorhanden|nicht definiert/i, "finding"],

// Erweiterungen/Handoff → task
[/erweiterung|handoff|übergabe|erweitert/i, "task"],
```

**Alternativ/ergänzend**: Für Conversation-Signale, die kein Pattern matchen, das `candidateType` intelligenter ableiten — z.B. über eine LLM-Klassifizierung als optionalen Schritt. Das wäre aber ein größeres Feature.

---

## Problem 3: Ledger-Struktur (Rotation statt Löschung)

### Aktuelles Verhalten
- Nach jedem Sync: Ledger wird komplett neu erstellt (`createLedger()`)
- Conversation-Signale werden aus dem vorherigen Ledger übernommen (manuell)
- Alles andere geht verloren
- Obligation-Kontinuität hängt von `mergeWithPreviousLedger()` ab

### Verbesserung: Signal-Rotation mit Cap

**In `sync.ts`** — statt komplett neu zu erstellen, den Ledger rotieren:

```ts
// VORHER:
const previousLedger = readLedger();
const ledger = createLedger({ commitHash, branch });

// NACHHER:
const previousLedger = readLedger();
const ledger = previousLedger
  ? rotateLedger(previousLedger, { commitHash, branch, maxSignals: 50 })
  : createLedger({ commitHash, branch });
```

**Neue Funktion `rotateLedger()` in `ledger.ts`:**

```ts
export function rotateLedger(
  prev: Ledger,
  opts: { commitHash?: string; branch?: string; topic?: string; maxSignals?: number }
): Ledger {
  const maxSignals = opts.maxSignals ?? 50;

  // Behalte nur die letzten N Signale (nach Datum sortiert)
  const sortedSignals = [...prev.rawSignals]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, maxSignals);

  // Behalte alle Candidates, die mit den verbleibenden Signalen verknüpft sind
  const signalIds = new Set(sortedSignals.map(s => s.id));
  const retainedCandidates = prev.candidates.filter(
    c => c.signalIds.some(id => signalIds.has(id))
  );

  return {
    ...prev,
    version: 2,
    sessionMeta: {
      ...prev.sessionMeta,
      updatedAt: new Date().toISOString(),
      topic: opts.topic ?? prev.sessionMeta.topic,
    },
    rawSignals: sortedSignals,
    candidates: retainedCandidates,
    // Obligations NICHT rotieren — die werden ohnehin via mergeWithPreviousLedger behandelt
    obligations: [],
    transitionNotes: prev.transitionNotes,
    syncRunState: {
      currentPhase: "raw",
      rawSignalIds: sortedSignals.map(s => s.id),
      candidateIds: retainedCandidates.map(c => c.id),
      obligationIds: [],
      syncStatus: "draft",
    },
    completionStatus: prev.completionStatus,
    commitHash: opts.commitHash ?? prev.commitHash,
    branch: opts.branch ?? prev.branch,
    updatedAt: new Date().toISOString(),
  };
}
```

### Vorteil
- **Kontext bleibt kontrolliert**: Max 50 Signale ≈ 3-4 KB im Agent-Kontext
- **Obligation-Kontinuität**: `mergeWithPreviousLedger()` hat immer Zugriff auf den vorherigen Ledger (der noch existiert)
- **Kein separates "Signals übernehmen"**: Conversation-Signale sind automatisch im rotierten Ledger
- **Debugging**: Letzte N Signale sind direkt im Ledger sichtbar, nicht nur in der History

---

## Zusammenfassung der Änderungen

| # | Datei | Änderung | Aufwand |
|---|-------|----------|---------|
| 1 | `orcha/packages/cli/src/lib/ledger.ts` | `appendSyncHistory()`: `c.category` → `c.candidateType` | 1 Zeile |
| 2 | `orcha/packages/cli/src/lib/candidates.ts` | `TYPE_PATTERNS` erweitern für Conversation-Signale | ~10 Zeilen |
| 3 | `orcha/packages/cli/src/lib/ledger.ts` | Neue Funktion `rotateLedger()` | ~40 Zeilen |
| 4 | `orcha/packages/cli/src/commands/sync.ts` | `createLedger()` → `rotateLedger()` wenn previous existiert | ~5 Zeilen |

Alle Änderungen sind im Orcha CLI (`~/Developer/orcha/packages/cli/`), **nicht** im Craft Agents OSS Repo.
