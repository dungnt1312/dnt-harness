import type { ReactNode } from 'react'
import { cn } from '../../lib/cn.ts'

/**
 * Pill group for one choice among a few. Segments are h-7 inside a 2px track
 * so the control lines up with h-8 `Button size="sm"` in the same row, and
 * `disabled` freezes it while a save is running.
 */
export function Segmented<V extends string>({ value, options, onChange, label, disabled = false, size = 'default' }: {
  readonly value: V | null
  readonly options: readonly { readonly value: V; readonly label: ReactNode }[]
  readonly onChange: (value: V) => void
  readonly label: string
  readonly disabled?: boolean
  readonly size?: 'default' | 'compact'
}) {
  return (
    <span className={cn('inline-flex shrink-0 rounded-lg bg-muted p-0.5', disabled && 'opacity-50')} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            'inline-flex items-center gap-1 rounded-md font-medium text-fg-muted transition-colors hover:text-fg disabled:pointer-events-none',
            size === 'compact' ? 'h-6 px-2 text-[11px]' : 'h-7 px-2.5 text-xs',
            option.value === value && 'bg-surface text-fg shadow-sm dark:bg-hover',
          )}
        >
          {option.label}
        </button>
      ))}
    </span>
  )
}
