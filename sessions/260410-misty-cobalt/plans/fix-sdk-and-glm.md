# Fix: Claude Code SDK + GLM 5.1

## Problem 1: Claude Code SDK not found

**Root Cause:** `electron-builder.yml` hat `!node_modules/**/*` als Exclude-Regel. Der `@anthropic-ai/claude-agent-sdk` wird über `extraResources` kopiert — aber der `from`-Pfad stimmt nicht:
- Aktuell: `from: node_modules/@anthropic-ai/claude-agent-sdk` (relativ zu `apps/electron/`)
- SDK liegt aber in: `../../node_modules/@anthropic-ai/claude-agent-sdk` (Root-`node_modules/`)

**Fix:** Alle 3 `extraResources`-Einträge in `apps/electron/electron-builder.yml` (Zeilen 102, 171, 205) ändern:
```yaml
- from: ../../node_modules/@anthropic-ai/claude-agent-sdk
  to: app/node_modules/@anthropic-ai/claude-agent-sdk
```

## Problem 2: GLM 5.1 hängt bei "thinking"/"percolating"

**Wahrscheinliche Ursache:** Der Pi Agent Server (der für Orcha Agents Backend / Pi-Modelle wie GLM genutzt wird) war bisher nicht in der App — jetzt ist er da, aber evtl. spawned er nicht korrekt, oder die Konfiguration stimmt nicht.

**Diagnose-Schritte:**
1. `resolveServerPath` für `pi-agent-server` prüft: `{appRootPath}/dist/resources/pi-agent-server/index.js` — diese Datei haben wir jetzt
2. Pi Agent Server benötigt evtl. `koffi` (native dependency) im node_modules — das fehlt
3. Check ob der Pi Agent Subprocess überhaupt startet (Console-Logs prüfen)

**Fix-Ansatz:**
- Pi Agent Server Log-Level erhöhen oder Console-Output prüfen
- `koffi` native library ins Bundle aufnehmen
- Ggf. fehlt ein Bun-Executable im Package (der Pi Agent Server braucht Bun oder Node um zu laufen)
