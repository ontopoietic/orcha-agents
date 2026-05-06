# Plan: Sync-Skill Indicator in der Ledger UI

## Überblick

Ein einzelner boolean-Indikator im LedgerPanel, der anzeigt, ob der Agent den Sync-Skill gelesen hat.
Der Agent setzt den Flag aktiv über ein neues MCP-Tool oder ein Label.

**Status:** ○ Sync-Skill nicht geladen → ● Sync-Skill geladen

## Architektur-Entscheidung: Labels statt neues MCP-Tool

Statt eines neuen IPC-Channels + SessionCommand + SessionEvent + EventProcessor-Handler nutzen wir das **bereits existierende Label-System**:

- Neues Label: `sync_skill_loaded`
- Wenn der Agent `[skill:sync]` erwähnt oder den Sync-Skill liest → `set_session_labels` mit `sync_skill_loaded`
- Das LedgerPanel prüft, ob das Label `sync_skill_loaded` in den Session-Labels existiert
- Keine neuen Protokoll-Typen, keine neuen IPC-Channels, keine neuen Event-Typen

**Vorteile:**
- Minimaler Code-Change (nur UI + System Prompt)
- Labels werden bereits persisted und über `labels_changed`-Events synchronisiert
- Der Indikator ist Teil der Session-Metadaten und überlebt App-Neustarts
- Konsistent mit dem bestehenden Label-Workflow

## Änderungen

### 1. Label in Labels-Konfiguration registrieren

**Datei:** `labels/config.json`

Neues Label hinzufügen (neue Kategorie `system`):
```json
{
  "id": "system",
  "name": "System",
  "color": {
    "light": "#22C55E",
    "dark": "#4ADE80"
  },
  "children": [
    {
      "id": "sync_skill_loaded",
      "name": "Sync Skill Loaded",
      "color": {
        "light": "#16A34A",
        "dark": "#4ADE80"
      }
    }
  ]
```

Labels werden in `labels/config.json` registriert und über `resolveLabelsFn` validiert. Der Agent kann das Label nur setzen, wenn es hier definiert ist.

### 2. LedgerPanel um Indikator erweitern

**Datei:** `apps/electron/src/renderer/components/app-shell/LedgerPanel.tsx`

- `focusedSessionId` + `sessionMetaMap` bereits verfügbar (bestehender Code)
- Prüfe ob `sessionMetaMap.get(focusedSessionId)?.labels?.includes('sync_skill_loaded')`
- Zeige kleinen farbigen Punkt neben dem "Ledger"-Titel:
  - **Grau** (`foreground/25`): Label nicht vorhanden
  - **Grün** (`--success`): Label vorhanden
- Tooltip: "Sync-Skill geladen" / "Sync-Skill nicht geladen"

```tsx
// Im Header-Bereich, nach dem "Ledger"-Span:
const syncSkillLoaded = focusedSessionId 
  ? sessionMetaMap.get(focusedSessionId)?.labels?.includes('sync_skill_loaded') ?? false
  : false

// Indikator-Punkt:
<span
  className={cn("h-1.5 w-1.5 rounded-full shrink-0",)}
  style={{
    backgroundColor: syncSkillLoaded
      ? "var(--success)"
      : "color-mix(in oklch, var(--foreground) 25%, transparent)"
  }}
  title={syncSkillLoaded ? "Sync-Skill geladen" : "Sync-Skill nicht geladen"}
/>
```

### 3. System Prompt / Skill Instruktionen erweitern

**Datei:** Skills-Konfiguration oder System-Prompt-Template

Wenn ein Sync-Skill existiert, muss dieser folgende Instruktion enthalten:

```markdown
## Pflichtaktion nach dem Lesen dieses Skills

Nachdem du diese SKILL.md gelesen hast, musst du sofort folgenden Tool-Aufruf machen:

set_session_labels mit: ["sync_skill_loaded"]

(Die bestehenden Labels müssen beibehalten werden — füge "sync_skill_loaded" hinzu.)
```

### 4. Sync-Skill erstellen (falls nicht existent)

**Verzeichnis:** `~/.agents/skills/sync/SKILL.md` oder Workspace-Level

Der Skill muss die Instruktion aus Schritt 3 enthalten. Inhalt des Skills ist separate Aufgabe — hier geht es nur um den Indikator-Mechanismus.

## Dateien im Überblick

| # | Datei | Änderung |
|---|-------|----------|
| 1 | Labels-Konfiguration | `sync_skill_loaded` Label registrieren |
| 2 | `apps/electron/src/renderer/components/app-shell/LedgerPanel.tsx` | Indikator-Dot im Header |
| 3 | Sync-Skill `SKILL.md` | Instruktion zum Setzen des Labels |

## Offene Fragen

1. ~~**Wo sind Labels definiert?**~~ — **Geklärt:** `labels/config.json` mit `resolveLabelsFn`-Validierung.
2. **Sync-Skill existiert noch nicht** — Soll der Skill im gleichen PR erstellt werden, oder nur der Indikator-Mechanismus?
3. ~~**Label-Resolution**~~ — **Geklärt:** Label muss in `labels/config.json` registriert sein, damit `resolveLabelsFn` es akzeptiert.

## Visualisierung

```
Vorher (Ledger Header):
  📖 Ledger  ● 3 neu  >

Nachher (Ledger Header):
  📖 Ledger  🟢  ● 3 neu  >    ← grüner Punkt = Sync-Skill geladen
  📖 Ledger  ⚪  ● 3 neu  >    ← grauer Punkt = Sync-Skill nicht geladen
```
