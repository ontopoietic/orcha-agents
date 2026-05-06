# FORK.md Update: App-Isolation Analyse

## Befund: Beide Apps teilen sich ALLES

**Root Cause:** `electron-builder.yml` nutzt `appId: com.lukilabs.craft-agent` — identisch mit dem Original.

Beide Apps (Craft Agents + Orcha Agents) greifen auf **dieselben Daten** zu:

| Geteilte Ressource | Pfad | Risiko |
|---|---|---|
| **Workspaces** | `~/.craft-agent/workspaces/` | Beide Apps zeigen dieselben Sessions |
| **Config** | `~/.craft-agent/config.json` | Workspaces, aktiver Workspace, LLM-Connections |
| **Credentials** | `~/.craft-agent/credentials.enc` | API-Keys werden von beiden Apps genutzt |
| **Preferences** | `~/.craft-agent/preferences.json` | Nutzerdaten, Timezone, Notizen |
| **Drafts** | `~/.craft-agent/drafts.json` | Session-Input-Drafts beider Apps |
| **Window State** | `~/.craft-agent/window-state.json` | Fensterposition/-größe |
| **Electron Data** | `~/Library/Application Support/Craft Agents/` | Server state, update state |
| **Caches** | `~/Library/Caches/com.lukilabs.craft-agent/` | Auto-update caches |
| **Plist** | `~/Library/Preferences/com.lukilabs.craft-agent.plist` | macOS System Preferences |

## Aktuelle Workspaces (geteilt!)

| Workspace | Pfad | Sessions |
|---|---|---|
| My Workspace | `~/.craft-agent/workspaces/my-workspace` | 115+ |
| Orcha | `~/.craft-agent/workspaces/orcha` | 40+ |
| Collibri | `~/Developer/Collibri` | — |
| Lukas Auer Coaching | `~/Developer/Lukas Auer Coaching/lukas-auer-coaching` | — |
| Orcha Agents | `~/Developer/craft-agents-oss` | 39 |

## Fix: Eigene appId

### 1. electron-builder.yml ändern
```yaml
appId: com.ontopoietic.orcha-agents    # statt com.lukilabs.craft-agent
productName: Orcha Agents
```

### 2. Config-Pfad im Code ändern
Suche wo `~/.craft-agent/` als Basispfad definiert ist und ändere zu `~/.orcha-agents/`.

Voraussichtlich in:
- `packages/shared/src/config/` — Daten-Root
- `apps/electron/src/main/index.ts` — Electron-Pfade

### 3. Neuen Daten-Pfad anlegen & migrieren
```bash
mkdir -p ~/.orcha-agents
# Nur den Orcha Agents Workspace kopieren:
cp -R ~/.craft-agent/workspaces/orcha ~/.orcha-agents/workspaces/
# LLM Connections, Credentials etc. kopieren:
cp ~/.craft-agent/config.json ~/.orcha-agents/
cp ~/.craft-agent/credentials.enc ~/.orcha-agents/
cp ~/.craft-agent/preferences.json ~/.orcha-agents/
```

### 4. config.json aufräumen
In `~/.orcha-agents/config.json` nur den Orcha Agents Workspace behalten, alle anderen entfernen.

### 5. Rebuild & Deploy
```bash
cd ~/Developer/craft-agents-oss
bun run electron:dist:dev:mac
# + Post-Build: SDK, Bun, Interceptor kopieren
# + Nach /Applications/ deployen
```

## Offene Fragen
- Soll die Original-App (Craft Agents) weiterhin den `my-workspace` und `orcha` Workspace sehen? → Vermutlich ja für `my-workspace`, nein für `orcha`
- Sollen Credentials/LLM-Connections komplett getrennt werden? → Empfohlen: ja
- Sollen Preferences geteilt bleiben? → Empfohlen: getrennt

## FORK.md Ergänzung (nach Mode-Wechsel einzutragen)

Unter "### 3. App-Isolation (appId-Trennung)" — die obige Tabelle + Lösung.

Danach Sections neu nummerieren:
- 3. App-Isolation
- 4. Dev-Build Runtime Patches
- 5. ZAI Models
