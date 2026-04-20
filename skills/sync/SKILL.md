---
name: "Sync"
description: "Ledger-Sync durchführen: Signale klassifizieren, Kandidaten zuordnen, Obligations prüfen"
alwaysAllow: ["Bash"]
---

# Sync-Skill — Ledger-Synchronisation

Du führst den Ledger-Sync für das aktuelle Arbeitsverzeichnis durch.

## ⚠️ Pflichtaktion nach dem Lesen

**Sobald du diese SKILL.md gelesen hast, setze sofort das Label:**

Rufe `set_session_labels` auf und füge `"sync_skill_loaded"` zu den bestehenden Labels hinzu. **Entferne keine bestehenden Labels** — ergänze nur das neue.

Beispiel: Wenn die aktuellen Labels `["development", "code"]` sind, setze `["development", "code", "sync_skill_loaded"]`.

Wenn keine Labels vorhanden sind, setze `["sync_skill_loaded"]`.

## Sync-Prozess

### 1. Ledger prüfen

Lies die aktuelle Ledger-Datei im Arbeitsverzeichnis:

```bash
cat .orcha-ledger.json | head -100
```

### 2. Signale klassifizieren

- Neue Signale identifizieren (status: "new")
- Jedes Signal einer Kategorie zuordnen
- Kandidaten mit Referenz auf die Signal-IDs erstellen

### 3. Obligations prüfen

- Offene Obligations auflisten
- Blocked-Obligations priorisieren
- Completion-Status bewerten: `complete | incomplete | blocked`

### 4. Ergebnis dokumentieren

- Sync-Ergebnis in der Ledger-Datei aktualisieren
- `completionStatus` und `syncPhase` korrekt setzen
- Zusammenfassung im Chat geben
