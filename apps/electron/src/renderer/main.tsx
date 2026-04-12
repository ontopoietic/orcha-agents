import React from 'react'
import ReactDOM from 'react-dom/client'
import { Provider as JotaiProvider, useAtomValue } from 'jotai'
import App from './App'
import { ThemeProvider } from './context/ThemeContext'
import { windowWorkspaceIdAtom } from './atoms/sessions'
import { Toaster } from '@/components/ui/sonner'
import { setupI18n } from '@craft-agent/shared/i18n'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
// Initialize i18n before any React rendering
setupI18n([LanguageDetector, initReactI18next])

import './index.css'

/**
 * Minimal fallback UI shown when the entire React tree crashes.
 * Shows the actual error for debugging.
 */
function CrashFallback({ error }: { error?: Error }) {
  return (
    <div className="flex flex-col items-center justify-center h-screen font-sans text-foreground/50 gap-3 p-8">
      <p className="text-base font-medium">Something went wrong</p>
      {error && <pre className="text-xs text-red-500 max-w-xl overflow-auto whitespace-pre-wrap">{error.message}{"\n"}{error.stack?.substring(0, 2000)}</pre>}
      <button
        onClick={() => window.location.reload()}
        className="mt-2 px-4 py-1.5 rounded-md bg-background shadow-minimal text-[13px] text-foreground/70 cursor-pointer"
      >
        Reload
      </button>
    </div>
  )
}

// Simple ErrorBoundary (class component required by React API)
class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      return <CrashFallback error={this.state.error} />
    }
    return this.props.children
  }
}

/**
 * Root component - loads workspace ID for theme context and renders App
 * App.tsx handles window mode detection internally (main vs tab-content)
 */
function Root() {
  // Shared atom — written by App on init & workspace switch, read here for ThemeProvider
  const workspaceId = useAtomValue(windowWorkspaceIdAtom)

  return (
    <ThemeProvider activeWorkspaceId={workspaceId}>
      <App />
      <Toaster />
    </ThemeProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <JotaiProvider>
        <Root />
      </JotaiProvider>
    </AppErrorBoundary>
  </React.StrictMode>
)
