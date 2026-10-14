import { cn } from '../../lib/cn.ts'

/** The one notice for a file read cut at 1 MB; the viewer and every preview say it the same way. */
export function TruncationNotice({ className }: { readonly className?: string }) {
  return (
    <p role="note" className={cn('m-0 border-b border-line bg-warn-soft px-3 py-1.5 text-xs text-warn', className)}>
      File is larger than 1 MB; only the beginning is shown.
    </p>
  )
}
