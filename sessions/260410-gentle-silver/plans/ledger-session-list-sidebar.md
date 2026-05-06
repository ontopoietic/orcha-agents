# Plan: Session-Liste im NavigatorPanel bei Ledger-View (Option A)

## Änderungen

### 1. Typ-Definition erweitern (`types.ts`)

In `NavigationState`-Union den `LedgerNavigation`-Typ hinzufügen:

```ts
export interface LedgerNavigationState {
  navigator: 'ledger'
  rightSidebar?: RightSidebarPanel
  selectedRunId?: string | null  // ID des selektierten Sync-Runs (für Detail-Ansicht)
}
```

### 2. Helper-Funktion hinzufügen (`NavigationContext.ts`)

```ts
export const isLedgerNavigation = (
  state: NavigationState
): state is LedgerNavigationState => state.navigator === 'ledger'
```

### 3. `isLedgerNavigation` in `isReady` einbeziehen (`NavigationContext.ts`)

Die `isReady`-Check wird für das automatisierte Panel-Wechsel erweitert, damit die ledger-navigierte Panel nicht zu früh als "bereit" markiert wird.

```ts
const canNavigate = (...states: NavigationState[]) =>
  isReady &&
  (isSessionsNavigation(...states) ||
   isSourcesNavigation(...states) ||
   isSettingsNavigation(...states) ||
   isSkillsNavigation(...states) ||
   isAutomationsNavigation(...states) ||
   isLedgerNavigation(...states))
```

### 4. `NavigationProvider`-State-Check erweitern (`AppShell.tsx`)

Wenn `isLedgerNavigation` aktiv ist, muss auch `isSessionsReady` als `true` gelten (da die Ledger-Detail-Seite die Sessions nicht neu laden muss, sondern vom Ledger-Leser kommt).

```ts
// VORHER
const canNavigate = (...states: NavigationState[]) =>
  isSessionsNavigation(...states) ||
  isSourcesNavigation(...states) ||
  isSettingsNavigation(...states) ||
  isSkillsNavigation(...states)

// NACHHER
const canNavigate = (...states: NavigationState[]) =>
  isSessionsNavigation(...states) ||
  isSourcesNavigation(...states) ||
  isSettingsNavigation(...states) ||
  isSkillsNavigation(...states) ||
  isAutomationsNavigation(...states) ||
  isLedgerNavigation(...states) // ← hinzugefügt
```

### 5. `MainContentPanel.tsx` - Navigator-Content erweitern

`MainContentPanel` muss auch die `LedgerNavigation` erkennen und `LedgerDetailPage` rendern (wie bei den anderen Navigations).

```ts
import { LedgerDetailPage } from '@/pages/LedgerDetailPage'

// VORHER - nur Chats-Navigation
if (isChatsNavigation(navState)) {
  return wrapWithSpotlight(<ChatDisplay ... />)
}

// NACHHER - auch Ledger-Navigation
if (isLedgerNavigation(navState)) {
  return wrapWithSpotlight(<LedgerDetailPage />)
}
```

### 6. Session-Liste für Ledger-Navigation erweitern (`AppShell.tsx`)

Die Session-Liste muss die Sync History Runs als separate Liste rendern (ähnlich wie `LedgerDetailPage` → `HistoryTab`). Dabei:

- `items`: Eine List-Struktur für Sync-Runs (nicht Sessions)
- `key`: `'ledger'` (statisch, damit die List nicht beim Panel-Wechsel neu gerendert wird)
- `onSelect`: Navigiert zur Ledger-Detail-Seite (Details-Ansicht des gewählten Runs)
- `itemType`: `'sync-run'` (neuer Typ, um Session-Items von Sync-Runs zu unterscheiden)

```tsx
// Nach dem isSessionsNavigation-Block:

{isLedgerNavigation(navState) && (
  <SessionList
    key="ledger"
    items={ledgerRuns}  // ← Sync History Runs statt Sessions
    onDelete={handleDeleteRun}  // ← Optional: Sync-Runs löschen (wenn gewünscht)
    onSelect={handleSelectRun}  // ← Run-Details im MainContentPanel
  />
)}
```

Dabei werden im Hintergrund die Sync-Runs aus der History (`.orcha-sync-history.json`) geladen und als List zur Verfügung gestellt.

## Umsetzung

| # | Datei | Änderung | Zeilen |
|---|-------|----------|-------|
| 1 | `shared/types.ts` | `LedgerNavigationState` Interface hinzufügen | ~15 |
| 2 | `NavigationContext.ts` | `isLedgerNavigation` Helper | ~5 |
| 3 | `NavigationContext.ts` | `isReady` Check erweitern | ~3 |
| 4 | `AppShell.tsx` | `canNavigate` Helper | ~10 |
| 5 | `components/app-shell/MainContentPanel.tsx` | `LedgerDetailPage` rendern | ~5 |
| 6 | `AppShell.tsx` | SessionList für Ledger erweitern | ~20 |

## Zusammenfassung

Wenn der Nutzer die Ledger-Seite öffnet:
1. **Sidebar**: Zeigt Session-Liste (wie bisher), aber jetzt mit einem dedizierten List-Typ für Sync-Runs
2. **Main-Content**: Zeigt `LedgerDetailPage` mit allen Tabs (History, Signale, Candidates, Obligations)
3. **Sync History**: Ist jetzt in der Sidebar als durchklickbare Liste von Sync-Runs
4. **Klick auf Run**: Öffnet die Detail-Ansicht des gewählten Sync-Runs im Main-Content

Dies ist ein konsistenter Ansatz – die Sync History ist in der Sidebar "auf Augenhöhe" mit den anderen Lists, aber die Details sind in der Main-Content.
