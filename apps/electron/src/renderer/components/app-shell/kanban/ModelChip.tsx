import { getModelDisplayName, getModelShortName, getModelProvider } from '@config/models'
import { getProviderIcon } from '@/lib/provider-icons'
import { cn } from '@/lib/utils'

interface ModelChipProps {
  /** Model id, e.g. 'claude-opus-4-7'. */
  model: string
  /** Show the short name ("Haiku") instead of the full display name ("Haiku 4.5"). */
  short?: boolean
  className?: string
}

/**
 * Read-only neutral chip: provider brand icon + model name. Reuses the centralized
 * model registry (`@config/models`) and provider icon map so it can't drift
 * from the real model metadata.
 */
export function ModelChip({ model, short = false, className }: ModelChipProps) {
  const provider = getModelProvider(model) ?? 'anthropic'
  const iconUrl = getProviderIcon(provider)
  const label = short ? getModelShortName(model) : getModelDisplayName(model)

  return (
    <span
      className={cn(
        'inline-flex h-5 min-w-0 items-center gap-1 rounded-xs bg-fill-hover px-1.5 text-label-sm text-secondary',
        className
      )}
    >
      {iconUrl ? (
        <img src={iconUrl} alt="" className="size-3 shrink-0 rounded-[2px]" aria-hidden />
      ) : (
        <span className="size-1.5 shrink-0 rounded-full bg-current text-tertiary" aria-hidden />
      )}
      <span className="min-w-0 truncate">{label}</span>
    </span>
  )
}
