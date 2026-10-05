import * as Popover from '@radix-ui/react-popover'
import { useState, type ReactNode } from 'react'
import { cn } from '../../lib/cn.ts'

/** Shared row look for menu items rendered inside {@link Menu}. */
export const menuItemClass = 'flex w-full min-h-9 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm text-fg outline-none hover:bg-hover focus-visible:bg-hover disabled:pointer-events-none disabled:opacity-40'

/** Popover menu: callers render trigger contents and items; Radix owns portal, focus and dismissal. */
export function Menu({ label, trigger, triggerClassName, panelClassName, panelRole = 'menu', disabled = false, side = 'bottom', align = 'start', compact = false, children }: {
  readonly label: string
  readonly trigger: (open: boolean) => ReactNode
  readonly triggerClassName?: string
  readonly panelClassName?: string
  readonly panelRole?: 'menu' | 'dialog'
  readonly disabled?: boolean
  readonly side?: 'top' | 'bottom' | 'left' | 'right'
  readonly align?: 'start' | 'center' | 'end'
  /** Exempts the trigger from the 44px coarse-pointer floor (composer control row). */
  readonly compact?: boolean
  readonly children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        {/* `title` mirrors the label so an icon-only chip still names itself on hover. */}
        <button type="button" disabled={disabled} className={triggerClassName} title={label} aria-label={label} aria-haspopup={panelRole} {...(compact ? { 'data-compact-control': true } : {})}>
          {trigger(open)}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          role={panelRole}
          aria-label={label}
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={12}
          className={cn(
            'z-50 max-h-[min(70vh,var(--radix-popover-content-available-height))] min-w-52 max-w-[calc(100vw-24px)] overflow-y-auto rounded-2xl border border-line bg-surface p-1.5 text-fg shadow-pop outline-none animate-fade-up',
            panelClassName,
          )}
        >
          {children(() => setOpen(false))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
