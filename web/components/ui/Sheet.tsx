import * as Dialog from '@radix-ui/react-dialog'
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn.ts'
import { useRestoreFocus } from '../../hooks/useRestoreFocus.ts'

/** Edge-attached modal panel (mobile navigation drawer, Context sheet). */
export function Sheet({ open, onOpenChange, side, label, className, children }: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly side: 'left' | 'right' | 'bottom'
  readonly label: string
  readonly className?: string
  readonly children: ReactNode
}) {
  const restoreFocus = useRestoreFocus(open)
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <Dialog.Content
          aria-label={label}
          aria-describedby={undefined}
          onCloseAutoFocus={restoreFocus}
          className={cn(
            'fixed z-40 flex flex-col overflow-hidden text-fg shadow-pop outline-none',
            // Safe-area padding: the drawer is fixed to the viewport, so unlike
            // the padded shell it must keep its own edges off the notch and
            // home indicator in the standalone PWA.
            side === 'bottom'
              ? 'inset-x-0 bottom-0 max-h-[min(70dvh,520px)] rounded-t-2xl border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]'
              : cn(
                  'inset-y-0 h-dvh pt-[env(safe-area-inset-top)]',
                  side === 'left'
                    ? 'left-0 w-[min(300px,calc(100vw-48px))] bg-sidebar pl-[env(safe-area-inset-left)] pb-[env(safe-area-inset-bottom)]'
                    : 'right-0 w-[min(440px,100vw)] border-l border-line bg-bg pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)]',
                ),
            className,
          )}
        >
          <Dialog.Title className="sr-only">{label}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
