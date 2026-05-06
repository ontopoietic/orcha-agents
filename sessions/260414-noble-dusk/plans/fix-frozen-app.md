# Fix: App friert ein — SplashScreen blockiert UI

## Problem
Die App ist "gefroren" — nichts ist klickbar, auch nach Neustart. Ursache: Der **SplashScreen** liegt als `fixed inset-0`-Overlay über der gesamten App und verschwindet nicht.

Zwei Probleme arbeiten zusammen:
1. **`z-splash` Tailwind-Klasse existiert nicht** — die CSS-Variable `--z-splash: 600` ist definiert, aber nicht im `@theme inline` Block registriert. Tailwind v4 generiert die Utility-Klasse daher nicht.
2. **Kein Timeout/Fallback** — wenn das Session-Laden oder die Initialisierung hängt, bleibt der Splash permanent sichtbar ohne Ausweg.

## Änderungen

### 1. Z-Index Variablen im `@theme` Block registrieren
**Datei:** `packages/ui/src/styles/index.css`

Alle `--z-*` Variablen in den `@theme inline` Block aufnehmen, damit Tailwind die Utility-Klassen (`z-splash`, `z-modal`, `z-overlay` etc.) generiert:

```css
/* Im @theme inline Block hinzufügen: */
--z-base: var(--z-base);
--z-local: var(--z-local);
--z-sticky: var(--z-sticky);
--z-titlebar: var(--z-titlebar);
--z-panel: var(--z-panel);
--z-dropdown: var(--z-dropdown);
--z-tooltip: var(--z-tooltip);
--z-modal: var(--z-modal);
--z-overlay: var(--z-overlay);
--z-fullscreen: var(--z-fullscreen);
--z-floating-backdrop: var(--z-floating-backdrop);
--z-floating-menu: var(--z-floating-menu);
--z-island-overlay: var(--z-island-overlay);
--z-island: var(--z-island);
--z-island-popover: var(--z-island-popover);
--z-splash: var(--z-splash);
```

### 2. SplashScreen Timeout als Sicherheitsnetz
**Datei:** `apps/electron/src/renderer/App.tsx`

Einen 10-Sekunden-Timeout einbauen, der den Splash automatisch versteckt, falls das Laden hängt:

```tsx
// Nach den bestehenden splash state hooks:
useEffect(() => {
  const timeout = setTimeout(() => {
    if (!splashHidden) {
      console.warn('[App] Splash screen timeout — forcing exit')
      setSplashExiting(true)
      setTimeout(() => setSplashHidden(true), 600)
    }
  }, 10_000)
  return () => clearTimeout(timeout)
}, [splashHidden])
```

### 3. `pointer-events: none` beim Exit
**Datei:** `apps/electron/src/renderer/components/SplashScreen.tsx`

Klicks sofort durchlassen sobald der Splash am Verschwinden ist:

```tsx
className={`fixed inset-0 z-splash flex items-center justify-center bg-background ${
  isExiting ? 'pointer-events-none' : ''
}`}
```

## Reihenfolge
1. Z-Index Fix (behebt das Kernproblem)
2. Splash Timeout (verhindert zukünftiges Einfrieren)
3. Pointer-events Fix (verbessert Exit-Übergang)

## Risiko
Niedrig — alle Änderungen sind defensiv und betreffen nur die Splash-/Startup-Logik.
