/**
 * CronBuilder
 *
 * Visual cron expression builder with three synchronized layers:
 * 1. Preset buttons — common schedules
 * 2. Visual fields — 5 interactive fields with dropdowns
 * 3. Raw expression — editable text input
 *
 * Plus human-readable summary and next-run preview.
 */

import * as React from 'react'
import { useState, useCallback, useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Clock, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { describeCron as describeCronExpression, computeNextRuns } from './utils'

// ============================================================================
// Presets
// ============================================================================

interface CronPreset {
  label: string
  cron: string
  description: string
}

const PRESETS: CronPreset[] = [
  { label: 'Every minute',       cron: '* * * * *',     description: 'Runs every minute' },
  { label: 'Every 15 min',       cron: '*/15 * * * *',  description: 'Runs every 15 minutes' },
  { label: 'Every hour',         cron: '0 * * * *',     description: 'At the top of every hour' },
  { label: 'Daily at midnight',  cron: '0 0 * * *',     description: 'Once a day at 00:00' },
  { label: 'Daily at 9am',       cron: '0 9 * * *',     description: 'Once a day at 09:00' },
  { label: 'Weekdays at 9am',    cron: '0 9 * * 1-5',   description: 'Monday–Friday at 09:00' },
  { label: 'Monthly on 1st',     cron: '0 0 1 * *',     description: 'First day of each month at 00:00' },
]

// ============================================================================
// Cron Field Definitions
// ============================================================================

interface FieldDef {
  label: string
  min: number
  max: number
  options?: { value: string; label: string }[]
}

const FIELDS: FieldDef[] = [
  { label: 'Minute', min: 0, max: 59 },
  { label: 'Hour', min: 0, max: 23 },
  { label: 'Day', min: 1, max: 31 },
  { label: 'Month', min: 1, max: 12, options: [
    { value: '1', label: 'Jan' }, { value: '2', label: 'Feb' }, { value: '3', label: 'Mar' },
    { value: '4', label: 'Apr' }, { value: '5', label: 'May' }, { value: '6', label: 'Jun' },
    { value: '7', label: 'Jul' }, { value: '8', label: 'Aug' }, { value: '9', label: 'Sep' },
    { value: '10', label: 'Oct' }, { value: '11', label: 'Nov' }, { value: '12', label: 'Dec' },
  ]},
  { label: 'Weekday', min: 0, max: 6, options: [
    { value: '0', label: 'Sun' }, { value: '1', label: 'Mon' }, { value: '2', label: 'Tue' },
    { value: '3', label: 'Wed' }, { value: '4', label: 'Thu' }, { value: '5', label: 'Fri' },
    { value: '6', label: 'Sat' },
  ]},
]

// ============================================================================
// Helpers
// ============================================================================

function validateCron(cron: string): string | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return 'Schedule needs 5 parts: minute, hour, day, month, and weekday'
  // Basic validation per field
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]
  for (let i = 0; i < 5; i++) {
    const part = parts[i]
    if (part === '*') continue
    if (/^\*\/\d+$/.test(part)) continue
    if (/^[\d,\-\/]+$/.test(part)) continue
    return `Invalid value in ${FIELDS[i]?.label ?? `field ${i + 1}`}: "${part}"`
  }
  return null
}

// ============================================================================
// Field Editor
// ============================================================================

interface CronFieldProps {
  field: FieldDef
  value: string
  onChange: (value: string) => void
}

function CronField({ field, value, onChange }: CronFieldProps) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-label-sm font-medium text-tertiary">
        {field.label}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="field-surface h-control-lg w-full rounded-md px-2 text-center font-mono text-mono-ui"
        placeholder="*"
      />
    </div>
  )
}

// ============================================================================
// Component
// ============================================================================

export interface CronBuilderProps {
  value?: string
  onChange?: (cron: string) => void
  timezone?: string
  onTimezoneChange?: (tz: string) => void
  className?: string
}

export function CronBuilder({
  value = '0 9 * * 1-5',
  onChange,
  timezone,
  onTimezoneChange,
  className,
}: CronBuilderProps) {
  const { t } = useTranslation()
  const [rawInput, setRawInput] = useState(value)
  const [fields, setFields] = useState<string[]>(value.split(/\s+/))

  // Sync raw input and fields
  useEffect(() => {
    setRawInput(value)
    setFields(value.split(/\s+/))
  }, [value])

  // Update from raw input
  const handleRawChange = useCallback((raw: string) => {
    setRawInput(raw)
    const parts = raw.trim().split(/\s+/)
    if (parts.length === 5) {
      setFields(parts)
      onChange?.(raw.trim())
    }
  }, [onChange])

  // Update from field editor
  const handleFieldChange = useCallback((index: number, val: string) => {
    const newFields = [...fields]
    newFields[index] = val || '*'
    setFields(newFields)
    const cron = newFields.join(' ')
    setRawInput(cron)
    onChange?.(cron)
  }, [fields, onChange])

  // Apply preset
  const handlePreset = useCallback((cron: string) => {
    setRawInput(cron)
    setFields(cron.split(/\s+/))
    onChange?.(cron)
  }, [onChange])

  const validationError = useMemo(() => validateCron(rawInput), [rawInput])
  const description = useMemo(() => describeCronExpression(rawInput), [rawInput])
  const nextRuns = useMemo(() => computeNextRuns(rawInput), [rawInput])

  return (
    <div className={cn('space-y-5', className)}>
      {/* Layer 1: Common Schedules */}
      <div className="space-y-2">
        <h4 className="text-label font-semibold text-foreground">
          Common Schedules
        </h4>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((preset) => (
            <button
              key={preset.cron}
              onClick={() => handlePreset(preset.cron)}
              aria-pressed={rawInput === preset.cron}
              className={cn(
                'motion-press inline-flex h-control items-center rounded-full px-2.5 text-label font-medium',
                rawInput === preset.cron
                  ? 'bg-fill-selected text-foreground inset-ring inset-ring-border'
                  : 'text-secondary inset-ring inset-ring-border hover:bg-fill-hover hover:text-foreground'
              )}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {/* Layer 2: Custom Schedule */}
      <div className="space-y-2">
        <h4 className="text-label font-semibold text-foreground">
          Custom Schedule
        </h4>
        <div className="grid grid-cols-5 gap-2">
          {FIELDS.map((field, i) => (
            <CronField
              key={field.label}
              field={field}
              value={fields[i] || '*'}
              onChange={(val) => handleFieldChange(i, val)}
            />
          ))}
        </div>
      </div>

      {/* Layer 3: Advanced */}
      <div className="space-y-2">
        <h4 className="text-label font-semibold text-foreground">
          Advanced
        </h4>
        <input
          type="text"
          value={rawInput}
          onChange={(e) => handleRawChange(e.target.value)}
          aria-invalid={validationError ? true : undefined}
          className="field-surface h-control-lg w-full rounded-md px-2.5 font-mono text-mono-ui"
          placeholder="* * * * *"
        />
        {validationError && (
          <div className="flex items-center gap-1.5 text-label-sm text-destructive">
            <AlertCircle className="size-3.5" aria-hidden />
            {validationError}
          </div>
        )}
      </div>

      {/* Summary */}
      <div className="space-y-3 rounded-lg bg-raised p-3.5 shadow-elev-1">
        {/* Human-readable description */}
        <div className="flex items-center gap-2">
          <Clock className="size-4 text-tertiary" aria-hidden />
          <span className="text-label font-medium text-foreground">{description}</span>
        </div>

        {/* Next runs */}
        {nextRuns.length > 0 && !validationError && (
          <div className="space-y-1">
            <span className="text-label-sm text-tertiary">Next runs:</span>
            <div className="flex flex-col gap-0.5">
              {(() => {
                const spansYears = nextRuns.length > 1 && nextRuns[0].getFullYear() !== nextRuns[nextRuns.length - 1].getFullYear()
                return nextRuns.map((date, i) => (
                  <span key={i} className="text-label-sm text-secondary tabular-nums">
                    {date.toLocaleDateString('en-US', {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                      ...(spansYears && { year: 'numeric' }),
                    })} {date.toLocaleTimeString('en-US', {
                      hour: '2-digit',
                      minute: '2-digit',
                      hour12: false,
                    })}
                  </span>
                ))
              })()}
            </div>
          </div>
        )}

        {/* Timezone */}
        <div className="flex items-center gap-2 text-label-sm text-tertiary">
          <span>{t('automations.labelTimezone')}:</span>
          <span className="font-medium text-secondary">{timezone || t('automations.systemDefault')}</span>
        </div>
      </div>
    </div>
  )
}
