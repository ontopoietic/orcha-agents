import * as React from 'react'
import type { ComponentEntry } from './types'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// ============================================================================
// Sonner Toast Playground
// Demonstrates different toast types, actions, and stacking behavior
// ============================================================================

type ToastType = 'default' | 'success' | 'error' | 'warning' | 'info' | 'loading' | 'action' | 'undo' | 'long-url'

const TOAST_TYPES: { id: ToastType; label: string; color: string }[] = [
  { id: 'default', label: 'Default', color: 'bg-foreground' },
  { id: 'success', label: 'Success', color: 'bg-success-solid' },
  { id: 'error', label: 'Error', color: 'bg-destructive-solid' },
  { id: 'warning', label: 'Warning', color: 'bg-info-solid' },
  { id: 'info', label: 'Info', color: 'bg-accent-solid' },
  { id: 'loading', label: 'Loading', color: 'bg-accent-solid' },
  { id: 'action', label: 'With Action', color: 'bg-foreground' },
  { id: 'undo', label: 'Undo (8s)', color: 'bg-foreground' },
  { id: 'long-url', label: 'With Long URL and Action', color: 'bg-accent-solid' },
]

function SonnerPlayground() {
  const [lastType, setLastType] = React.useState<ToastType>('default')

  const showToast = (type: ToastType) => {
    setLastType(type)

    switch (type) {
      case 'success':
        toast.success('Success!', { description: 'Your action completed successfully.' })
        break
      case 'error':
        toast.error('Error', { description: 'Something went wrong. Please try again.' })
        break
      case 'warning':
        toast.warning('Warning', { description: 'This action may have consequences.' })
        break
      case 'info':
        toast.info('Info', { description: 'Here is some useful information.' })
        break
      case 'loading':
        toast.loading('Loading...', { description: 'Please wait while we process.' })
        break
      case 'action':
        toast('Session deleted', {
          description: 'Your session has been removed.',
          action: {
            label: 'Undo',
            onClick: () => toast.success('Restored!'),
          },
        })
        break
      case 'undo':
        toast('Session archived', {
          duration: 8000,
          action: {
            label: 'Undo',
            onClick: () => toast.success('Restored'),
          },
        })
        break
      case 'long-url':
        toast('Resource available', {
          description: 'https://api.example.com/v2/organizations/acme-corp/projects/my-super-long-project-name/resources/12345/details?include=metadata&format=json',
          action: {
            label: 'Open',
            onClick: () => toast.success('Opening URL...'),
          },
        })
        break
      default:
        toast('Default toast', { description: 'This is a basic notification.' })
    }
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h2 className="text-label-lg font-semibold mb-1">Toast Types</h2>
        <p className="text-label text-secondary mb-4">
          Click to trigger different toast styles. Last triggered: <span className="font-medium">{lastType}</span>
        </p>
        <div className="flex flex-wrap gap-2">
          {TOAST_TYPES.map((t) => (
            <Button
              key={t.id}
              variant="secondary"
              onClick={() => showToast(t.id)}
              aria-pressed={lastType === t.id}
            >
              <span className={cn('size-2.5 rounded-full', t.color)} />
              {t.label}
            </Button>
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-label-lg font-semibold mb-2">Quick Actions</h2>
        <div className="flex flex-wrap gap-2">
          <Button variant="danger" onClick={() => toast.dismiss()}>
            Dismiss All
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              const id = toast.loading('Processing...')
              setTimeout(() => toast.success('Done!', { id }), 2000)
            }}
          >
            Loading → Success
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              for (let i = 0; i < 4; i++) {
                setTimeout(() => toast(`Toast ${i + 1}`), i * 200)
              }
            }}
          >
            Stack 4 Toasts (3 visible)
          </Button>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// Component Registry Entries
// ============================================================================

export const toastsComponents: ComponentEntry[] = [
  {
    id: 'sonner-toasts',
    name: 'Sonner Toasts',
    category: 'Toast Messages',
    description: 'Toast notifications with different types, actions, and stacking behavior',
    component: SonnerPlayground,
    props: [],
    variants: [],
    mockData: () => ({}),
  },
]
