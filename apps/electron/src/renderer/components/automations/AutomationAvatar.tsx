/**
 * AutomationAvatar
 *
 * Small icon component that visually categorizes automations by event type.
 * Uses colored backgrounds with matching Lucide icons.
 */

import * as React from 'react'
import {
  Clock,
  Tag,
  Shield,
  Flag,
  ListChecks,
  Zap,
  CheckCircle2,
  AlertTriangle,
  MessageSquare,
  Webhook,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { getEventCategory, type AutomationTrigger, type EventCategory } from './types'

// ============================================================================
// Size Configuration
// ============================================================================

type AvatarSize = 'xs' | 'sm' | 'md' | 'lg'

const sizeConfig: Record<AvatarSize, { container: string; icon: string }> = {
  xs: { container: 'h-3.5 w-3.5', icon: 'h-2 w-2' },
  sm: { container: 'h-4 w-4', icon: 'h-2.5 w-2.5' },
  md: { container: 'h-5 w-5', icon: 'h-3 w-3' },
  lg: { container: 'h-6 w-6', icon: 'h-3.5 w-3.5' },
}

// ============================================================================
// Event → Icon + Color Mapping
// ============================================================================

// Role tints with their solved text colors (the pre-redesign `warning` color never existed: it is info/amber)
const categoryConfig: Record<EventCategory, { icon: React.ElementType; bg: string; text: string }> = {
  scheduled:    { icon: Clock,          bg: 'bg-success-tint',      text: 'text-success' },
  label:        { icon: Tag,            bg: 'bg-accent-tint',       text: 'text-accent' },
  permission:   { icon: Shield,         bg: 'bg-info-tint',         text: 'text-info' },
  flag:         { icon: Flag,           bg: 'bg-info-tint',         text: 'text-info' },
  todo:         { icon: ListChecks,     bg: 'bg-info-tint',         text: 'text-info' },
  'agent-pre':  { icon: Zap,            bg: 'bg-info-tint',         text: 'text-info' },
  'agent-post': { icon: CheckCircle2,   bg: 'bg-success-tint',      text: 'text-success' },
  'agent-error':{ icon: AlertTriangle,  bg: 'bg-destructive-tint',  text: 'text-destructive' },
  session:      { icon: MessageSquare,  bg: 'bg-fill-hover',        text: 'text-secondary' },
  other:        { icon: Webhook,        bg: 'bg-fill-hover',        text: 'text-secondary' },
}

// ============================================================================
// Component
// ============================================================================

export interface AutomationAvatarProps {
  event: AutomationTrigger
  size?: AvatarSize
  /** Fill parent container (h-full w-full). Overrides size. */
  fluid?: boolean
  className?: string
}

export function AutomationAvatar({ event, size = 'md', fluid, className }: AutomationAvatarProps) {
  const category = getEventCategory(event)
  const config = categoryConfig[category]
  const sizes = sizeConfig[size]
  const Icon = config.icon

  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-xs shrink-0',
        // The hero tile draws its own hairline; small avatars carry theirs
        fluid ? 'h-full w-full' : cn(sizes.container, 'ring-1 ring-border'),
        config.bg,
        className
      )}
    >
      <Icon className={cn(fluid ? 'h-[60%] w-[60%]' : sizes.icon, config.text)} />
    </span>
  )
}
