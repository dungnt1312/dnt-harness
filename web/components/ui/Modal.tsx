import * as Dialog from '@radix-ui/react-dialog'
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn.ts'
import { useRestoreFocus } from '../../hooks/useRestoreFocus.ts'

type ModalWidth = 'sm' | 'md' | 'lg' | 'xl'

const WIDTHS: Readonly<Record<ModalWidth, string>> = {
  sm: 'w-[min(420px,calc(100vw-32px))]',
  md: 'w-[min(560px,calc(100vw-32px))]',
  lg: 'w-[min(720px,calc(100vw-32px))]',
  xl: 'h-[min(760px,calc(100dvh-32px))] w-[min(1040px,calc(100vw-32px))] max-sm:h-dvh max-sm:w-screen max-sm:rounded-none max-sm:pb-[env(safe-area-inset-bottom)] max-sm:pt-[env(safe-area-inset-top)]',
}

const contentClass = 'fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-32px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-surface text-fg shadow-pop outline-none max-sm:max-h-dvh'

/** Controlled centered dialog; Radix owns portal, focus trap, restoration and Escape. */
export function Modal({ open, onDismiss, label, width = 'lg', className, bodyClassName, header, children }: {
  readonly open: boolean
  readonly onDismiss: () => void
  readonly label: string
  readonly width?: ModalWidth
  readonly className?: string
  readonly bodyClassName?: string
  readonly header?: ReactNode
  readonly children: ReactNode
}) {
  const restoreFocus = useRestoreFocus(open)
  if (!open) return null
  const content = (
    <>
      {header !== undefined ? <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-3">{header}</header> : null}
      <div className={cn('min-h-0 flex-1 overflow-y-auto p-5', bodyClassName)}>{children}</div>
    </>
  )
  // Static rendering (tests) has no portal target.
  if (typeof document === 'undefined') {
    return <div role="presentation"><div role="dialog" aria-modal="true" aria-label={label} className={cn(contentClass, WIDTHS[width], className)}>{content}</div></div>
  }
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onDismiss() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim" />
        <Dialog.Content aria-label={label} aria-describedby={undefined} onCloseAutoFocus={restoreFocus} className={cn(contentClass, WIDTHS[width], className)}>
          <Dialog.Title className="sr-only">{label}</Dialog.Title>
          {content}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
