import * as RadixSwitch from '@radix-ui/react-switch'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn.ts'

/**
 * The one switch track. The global touch rule (`min-height/min-width: 44px`
 * on every <button> under `pointer: coarse`) would stretch this 36x20 track
 * into a 44px circle with the thumb stranded in the middle, so the track opts
 * out with `data-compact-control` and keeps its drawn size. Its 44px touch
 * target is a transparent `before:` layer instead: 12px above and below, 4px
 * either side, so adjacent controls still never overlap it.
 */
export function SwitchTrack({ className, ...props }: ComponentProps<typeof RadixSwitch.Root>) {
  return (
    <RadixSwitch.Root
      data-compact-control
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-line-strong transition-colors before:absolute before:-inset-x-1 before:-inset-y-3 before:content-[\'\'] disabled:opacity-50 data-[state=checked]:bg-primary',
        className,
      )}
      {...props}
    >
      <RadixSwitch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-bg shadow transition-transform data-[state=checked]:translate-x-[18px]" />
    </RadixSwitch.Root>
  )
}

/** Controlled switch; the Radix root is the sole interactive control. */
export function Switch({ checked, onChange, label, hint, disabled = false }: {
  readonly checked: boolean
  readonly onChange: (next: boolean) => void
  readonly label: string
  readonly hint?: string
  readonly disabled?: boolean
}) {
  return (
    <label className={cn('flex items-start justify-between gap-4', disabled && 'opacity-50')}>
      <span className="flex min-w-0 flex-col">
        <span className="text-sm text-fg">{label}</span>
        {hint !== undefined ? <span className="text-xs text-fg-faint">{hint}</span> : null}
      </span>
      <SwitchTrack checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={label} className="mt-0.5" />
    </label>
  )
}
