import { Button } from '../ui/Button.tsx'

/**
 * The file moved on disk under an unsaved edit: look at the difference, take
 * the disk version, or keep going and overwrite it. The one strip that
 * appears above the editor, and only while there is something to decide.
 */
export function ConflictBanner({ comparing, busy, onCompare, onReload, onOverwrite }: {
  readonly comparing: boolean
  readonly busy: boolean
  readonly onCompare: () => void
  readonly onReload: () => void
  readonly onOverwrite: () => void
}) {
  return (
    <div role="alert" className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line bg-warn-soft px-3 py-2 text-[13px] text-warn">
      <span className="min-w-0">This file changed on disk since you opened it.</span>
      <div className="flex shrink-0 items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={onCompare}>{comparing ? 'Hide comparison' : 'Compare'}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onReload}>Reload</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onOverwrite}>Overwrite</Button>
      </div>
    </div>
  )
}
