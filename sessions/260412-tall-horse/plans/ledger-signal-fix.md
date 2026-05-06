# Ledger Signal Fix — Explore-Mode Permissions

## Summary

Orcha-Agenten im Explore-Mode können keine `signal add` / `sync` Befehle ausführen, obwohl die CLAUDE.md das als Pflicht vorschreibt. Fix: Bash-Patterns in der Permission-Allowlist ergänzen.

## Steps

1. **`default.json` erweitern** — Zwei neue `allowedBashPatterns` hinzufügen:
   - `^npx\s+tsx\s+packages/cli/src/index\.ts\s+signal\b` (signal add, signal list)
   - `^npx\s+tsx\s+packages/cli/src/index\.ts\s+sync\b` (sync command)

   Datei: `/Users/timokurz/.orcha-agents/permissions/default.json`

2. **`source .env.local` prüfen** — Die CLI braucht Environment-Variablen (`ORCHA_API_TOKEN` etc.). Da `source` nicht in der Allowlist ist und Redirects/Subshells in Explore blocked sind, gibt es zwei Optionen:
   - **Option A:** `source` ebenfalls allowlisten (einfach, aber öffnet Shell-State-Manipulation)
   - **Option B:** Die CLI selbst `.env.local` parsen lassen (sauberer, aber erfordert CLI-Änderung)
   - **Empfehlung:** Option A mit engem Pattern (`^source\s+\.env\.local$`) — minimaler Blast-Radius

3. **CLAUDE.md verschärfen** (optional) — Im Signal-Abschnitt einen expliziten Trigger ergänzen: _"Sobald du eine konzeptionelle Erkenntnis formuliert hast, schreibe sofort `orcha signal add`."_

## Nicht im Scope

- Nachträgliche Signal-Erfassung aus Session 260412-wild-beach (separater Task, braucht Orcha-Projektkontext)
- Workspace-level `permissions.json` — nicht nötig, da die Default-Permissions für alle Orcha-Agenten gelten sollen
