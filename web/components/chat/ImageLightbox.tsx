import * as Dialog from '@radix-ui/react-dialog'
import Icon from '../common/Icon.tsx'
import { useRestoreFocus } from '../../hooks/useRestoreFocus.ts'

/** Full-size view of one image; Esc, ✕ or a click outside the image closes it. */
export function ImageLightbox({ src, alt, onDismiss }: {
  readonly src: string | null
  readonly alt: string
  readonly onDismiss: () => void
}) {
  const open = src !== null
  const restoreFocus = useRestoreFocus(open)
  if (!open || typeof document === 'undefined') return null
  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) onDismiss() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/80" />
        <Dialog.Content
          aria-label={alt}
          aria-describedby={undefined}
          onCloseAutoFocus={restoreFocus}
          onClick={(event) => { if (event.target === event.currentTarget) onDismiss() }}
          className="fixed inset-0 z-50 flex items-center justify-center p-6 outline-none sm:p-12"
        >
          <Dialog.Title className="sr-only">{alt}</Dialog.Title>
          <img src={src} alt={alt} className="max-h-full max-w-full rounded-lg object-contain shadow-pop" />
          <Dialog.Close
            aria-label="Close preview"
            className="absolute right-4 top-4 flex size-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
          >
            <Icon name="close" size={18} />
          </Dialog.Close>
          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            className="absolute bottom-4 left-1/2 max-w-[80vw] -translate-x-1/2 truncate rounded-full bg-white/10 px-3 py-1 text-xs text-white/80 hover:bg-white/20 hover:text-white"
          >
            {alt}
          </a>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
